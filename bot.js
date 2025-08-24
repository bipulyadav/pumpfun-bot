// ========= Pump.fun Strategy Bot (ESM) =========
// Signals: early unique buyers, buy velocity, buy/sell ratio, liquidity window, whale dominance
// Entry: after ~2.5s micro-window scoring (not instant market buy)
// Exit: +TAKE_PROFIT_PCT take-profit (existing), you can add SL later

import 'dotenv/config';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { fetch, Agent } from 'undici';
import {
  Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL
} from '@solana/web3.js';

// ====== CORE ENV ======
const RPC_URL       = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBKEY        = process.env.PUBLIC_KEY;               // Local: your wallet | Lightning: lightning wallet pubkey
const SECRET        = process.env.WALLET_PRIVATE_KEY;       // Local only (bs58)
const BUY_SOL       = parseFloat(process.env.BUY_SOL || '0.005');
const SLIPPAGE      = parseInt(process.env.SLIPPAGE || '15', 10);
const PRIORITY_FEE  = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const TAKE_PROFIT   = parseFloat(process.env.TAKE_PROFIT_PCT || '50') / 100;

// ====== STRATEGY ENV (tune as needed) ======
const BUY_WINDOW_MS        = parseInt(process.env.BUY_WINDOW_MS || '2500', 10);  // observation window
const MIN_BUYS             = parseInt(process.env.MIN_BUYS || '12', 10);
const MIN_UNIQUE           = parseInt(process.env.MIN_UNIQUE || '10', 10);
const MIN_BUY_SELL_RATIO   = parseFloat(process.env.MIN_BUY_SELL_RATIO || '4.0');
const MAX_WHALE_SHARE      = parseFloat(process.env.MAX_WHALE_SHARE || '0.35');  // <=35%
const MIN_LIQ_SOL          = parseFloat(process.env.MIN_LIQ_SOL || '0.30');      // vSolInBondingCurve
const MAX_LIQ_SOL          = parseFloat(process.env.MAX_LIQ_SOL || '5.0');
const MIN_SCORE            = parseFloat(process.env.MIN_SCORE || '0.75');        // 0..1 composite
const COOLDOWN_MS          = parseInt(process.env.BUY_COOLDOWN_MS || '60000', 10);

// Optional Lightning mode
const USE_LIGHTNING = (process.env.USE_LIGHTNING || 'false').toLowerCase() === 'true';
const PP_API_KEY    = process.env.PP_API_KEY || '';

console.log('[ENV] RPC_URL =', RPC_URL);
console.log('[ENV] PUBLIC_KEY set =', !!PUBKEY);
console.log('[ENV] WALLET_PRIVATE_KEY set =', !!SECRET, '(ignored in Lightning mode)');
console.log('[ENV] USE_LIGHTNING =', USE_LIGHTNING);

// ====== CONNECTIONS ======
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const httpAgent = new Agent({ keepAlive: true, keepAliveTimeout: 60e3, keepAliveMaxTimeout: 60e3 });

// signer (local only)
let signer = null;
if (!USE_LIGHTNING) {
  if (!PUBKEY || !SECRET) {
    console.error('Secrets not set! Need PUBLIC_KEY & WALLET_PRIVATE_KEY for local mode.');
    setInterval(() => {}, 1e9);
  } else {
    signer = Keypair.fromSecretKey(bs58.decode(SECRET));
  }
} else {
  if (!PP_API_KEY || !PUBKEY) {
    console.error('Lightning mode: set PP_API_KEY and PUBLIC_KEY (lightning wallet).');
    setInterval(() => {}, 1e9);
  }
}

// ====== STATE ======
const WS_URL = 'wss://pumpportal.fun/api/data';
const pos = new Map();      // mint -> { entryCostSol, tokenQty }
const watch = new Map();    // mint -> { start, timer, buys, sells, buyers Map(addr->tokens), lastVSol }
let lastBuyAt = 0;

// ====== HELPERS ======
function estSolPerToken(m) {
  const vs = +m?.vSolInBondingCurve, vt = +m?.vTokensInBondingCurve;
  return (vs > 0 && vt > 0) ? (vs / vt) : null;
}
async function logAndGetBalance() {
  if (USE_LIGHTNING || !signer) return null;
  try {
    const lamports = await conn.getBalance(signer.publicKey);
    const sol = lamports / LAMPORTS_PER_SOL;
    console.log('[BALANCE]', sol.toFixed(6), 'SOL | addr =', signer.publicKey.toBase58());
    return sol;
  } catch (e) {
    console.error('[BALANCE FAIL]', e?.message || e);
    return 0;
  }
}
const COMMON_HEADERS = {
  accept: '*/*', 'user-agent': 'pump-bot/1.0',
  origin: 'https://pump.fun', referer: 'https://pump.fun/'
};
async function postJson(url, body) {
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...COMMON_HEADERS },
    body: JSON.stringify(body), dispatcher: httpAgent
  });
}
async function postForm(url, body) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.append(k, String(v));
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...COMMON_HEADERS },
    body: form.toString(), dispatcher: httpAgent
  });
}

// ====== TRADE (LOCAL / LIGHTNING) ======
const TRADE_ENDPOINTS = [
  process.env.TRADE_URL || 'https://pumpportal.fun/api/trade-local',
  'https://www.pumpportal.fun/api/trade-local',
];
async function tradeLocal(body) {
  for (const url of TRADE_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // JSON first
        let r = await postJson(url, body);
        let bytes;
        try {
          const ab = await r.arrayBuffer();
          const u8 = new Uint8Array(ab);
          if (u8.length > 0) bytes = u8;
        } catch {}
        if (!bytes) {
          try {
            const j = await r.json();
            const b64 = j?.transaction || j?.tx || j?.data;
            if (b64) bytes = Buffer.from(b64, 'base64');
          } catch {
            // FORM fallback
            r = await postForm(url, body);
            try {
              const ab2 = await r.arrayBuffer();
              const u82 = new Uint8Array(ab2);
              if (u82.length > 0) bytes = u82;
            } catch {}
            if (!bytes) {
              const j2 = await r.json().catch(()=>null);
              const b64b = j2?.transaction || j2?.tx || j2?.data;
              if (b64b) bytes = Buffer.from(b64b, 'base64');
            }
          }
        }
        if (!bytes) throw new Error(`trade-local no-bytes (${r.status})`);
        const tx = VersionedTransaction.deserialize(bytes);
        tx.sign([signer]);
        const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
        console.log('[TRADE OK]', body.action, 'mint=', body.mint, 'sig=', sig);
        return sig;
      } catch (e) {
        console.error('[tradeLocal]', url, 'attempt', attempt, e?.code || e?.name || '', e?.message || e);
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
  }
  return null;
}
const TRADE_LIGHTNING = `https://pumpportal.fun/api/trade?api-key=${PP_API_KEY}`;
async function tradeLightning(body) {
  const payload = {
    action: body.action, mint: body.mint, amount: body.amount,
    denominatedInSol: body.denominatedInSol, slippage: body.slippage,
    priorityFee: body.priorityFee, pool: body.pool || 'auto', skipPreflight: 'true'
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await postJson(TRADE_LIGHTNING, payload);
      const j = await r.json().catch(()=>null);
      if (!r.ok) throw new Error(JSON.stringify(j || {}));
      const sig = j?.signature || j?.txSig || null;
      if (sig) console.log('[TRADE OK LGT]', body.action, 'mint=', body.mint, 'sig=', sig);
      return sig;
    } catch (e) {
      console.error('[tradeLightning]', attempt, e?.message || e);
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  return null;
}
async function trade(body) { return USE_LIGHTNING ? await tradeLightning(body) : await tradeLocal(body); }

// ====== STRATEGY SCORER ======
function startWatch(m) {
  const mint = m.mint;
  if (watch.has(mint)) return;
  const rec = {
    start: Date.now(), buys: 0, sells: 0, buyers: new Map(), lastVSol: +m?.vSolInBondingCurve || 0,
    timer: setTimeout(()=>evaluateMint(mint), BUY_WINDOW_MS)
  };
  watch.set(mint, rec);
}
function updateWatch(m) {
  const rec = watch.get(m.mint);
  if (!rec) return;
  if (Date.now() - rec.start > BUY_WINDOW_MS) return;
  if (m.txType === 'buy') {
    rec.buys++;
    const addr = m.traderPublicKey || 'unknown';
    const got  = Number(m.tokenAmount || 0);
    rec.buyers.set(addr, (rec.buyers.get(addr) || 0) + got);
  }
  if (m.txType === 'sell') rec.sells++;
  if (+m?.vSolInBondingCurve > 0) rec.lastVSol = +m.vSolInBondingCurve;
}
function evaluateMint(mint) {
  const rec = watch.get(mint);
  if (!rec) return;
  watch.delete(mint);

  // compute metrics
  const buys = rec.buys, sells = rec.sells;
  const unique = rec.buyers.size;
  const ratio = buys / Math.max(1, sells);
  const vsol = rec.lastVSol;

  // whale share
  let totalTok = 0, maxTok = 0;
  for (const v of rec.buyers.values()) { totalTok += v; if (v > maxTok) maxTok = v; }
  const whaleShare = totalTok > 0 ? (maxTok / totalTok) : 0;

  // raw gates
  const gates =
    buys >= MIN_BUYS &&
    unique >= MIN_UNIQUE &&
    ratio >= MIN_BUY_SELL_RATIO &&
    vsol >= MIN_LIQ_SOL && vsol <= MAX_LIQ_SOL &&
    whaleShare <= MAX_WHALE_SHARE;

  // score (0..1)
  const f = (x, t) => Math.min(1, x / t);
  const vsolOK = (vsol >= MIN_LIQ_SOL && vsol <= MAX_LIQ_SOL) ? 1 : 0;
  const score =
    0.25 * f(buys,   MIN_BUYS) +
    0.25 * f(unique, MIN_UNIQUE) +
    0.20 * f(ratio,  MIN_BUY_SELL_RATIO) +
    0.20 * (1 - Math.min(1, whaleShare / MAX_WHALE_SHARE)) +
    0.10 * vsolOK;

  console.log('[SCORE]', mint, 'buys=', buys, 'unique=', unique, 'ratio=', ratio.toFixed(2),
              'vsol=', vsol.toFixed(2), 'whale=', (whaleShare*100).toFixed(1)+'%', '→ score=', score.toFixed(2));

  if (!gates || score < MIN_SCORE) return; // skip weak ones
  // cooldown
  if (Date.now() - lastBuyAt < COOLDOWN_MS) { console.log('[SKIP] cooldown'); return; }
  // balance guard (local only)
  if (!USE_LIGHTNING && signer) {
    const need = BUY_SOL + PRIORITY_FEE + 0.002;
    // we won't await balance here to avoid delay; last fetched balance is enough
  }
  instantBuy(mint);
}

async function instantBuy(mint) {
  // local balance check
  if (!USE_LIGHTNING) {
    const bal = await logAndGetBalance();
    const need = (BUY_SOL || 0) + (PRIORITY_FEE || 0) + 0.002;
    if (typeof bal === 'number' && bal < need) {
      console.error('[SKIP BUY] Low balance. have=', (bal||0).toFixed(4), 'need≈', need.toFixed(4));
      return;
    }
  }
  const body = {
    publicKey: PUBKEY, action: 'buy', mint,
    amount: BUY_SOL, denominatedInSol: 'true',
    slippage: SLIPPAGE, priorityFee: PRIORITY_FEE, pool: 'auto'
  };
  const sig = await trade(body);
  if (sig) {
    pos.set(mint, { entryCostSol: BUY_SOL + PRIORITY_FEE, tokenQty: 0 });
    lastBuyAt = Date.now();
  }
}

async function sellAll(mint) {
  const body = {
    publicKey: PUBKEY, action: 'sell', mint,
    amount: '100%', denominatedInSol: 'false',
    slippage: SLIPPAGE, priorityFee: PRIORITY_FEE, pool: 'auto'
  };
  await trade(body);
  pos.delete(mint);
}

// ====== WS LOOP ======
function openWS() {
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false });

  ws.on('open', () => {
    console.log('[WS] Connected');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [PUBKEY] }));
  });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }

    // 1) New token → start observation window (no instant buy)
    if (m?.txType === 'create' && m?.mint) {
      console.log('[NEW TOKEN]', m.mint);
      startWatch(m);
      return;
    }

    // 2) Update watch with orderflow
    if (m?.mint && watch.has(m.mint)) updateWatch(m);

    // 3) Our account trades (fills)
    if (m?.traderPublicKey === PUBKEY && m?.mint) {
      const p = pos.get(m.mint);
      if (p) {
        if (m.txType === 'buy') {
          const got = Number(m.tokenAmount || m.newTokenBalance || 0);
          if (got > 0 && p.tokenQty === 0) {
            p.tokenQty = got;
            console.log('[POSITION] qty=', got);
          }
        }
        if (m.txType === 'sell') {
          pos.delete(m.mint);
          console.log('[POSITION] sold all', m.mint);
        }
      }
      return;
    }

    // 4) Price ticks → take-profit
    if (m?.mint && pos.has(m.mint)) {
      const p = pos.get(m.mint);
      if (!p?.tokenQty) return;
      const spt = estSolPerToken(m);
      if (!spt) return;
      const estExit = spt * p.tokenQty;
      const target = p.entryCostSol * (1 + TAKE_PROFIT);
      if (estExit >= target) {
        console.log('[TP HIT]', m.mint, 'exit≈', estExit.toFixed(4), 'target≈', target.toFixed(4));
        sellAll(m.mint);
      }
    }
  });

  ws.on('close', () => { console.error('[WS] Closed → reconnecting...'); setTimeout(openWS, 1000); });
  ws.on('error', (e) => console.error('[WS error]', e?.message || e));
}

openWS();
setInterval(() => {}, 1e9); // keep process alive
