// ========= Pump.fun Strategy Bot (ESM, Lightning-ready) =========

import 'dotenv/config';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { fetch, Agent } from 'undici';
import {
  Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL
} from '@solana/web3.js';

/* ---------- CORE ENV ---------- */
const RPC_URL       = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBKEY        = process.env.PUBLIC_KEY;                // Local: your wallet | Lightning: lightning wallet pubkey
const SECRET        = process.env.WALLET_PRIVATE_KEY;        // Local only (bs58)
const BUY_SOL       = parseFloat(process.env.BUY_SOL || '0.005');
const SLIPPAGE      = parseInt(process.env.SLIPPAGE || '15', 10);
const PRIORITY_FEE  = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const TAKE_PROFIT   = parseFloat(process.env.TAKE_PROFIT_PCT || '50') / 100;
const STOP_LOSS     = parseFloat(process.env.STOP_LOSS_PCT || '25') / 100;

/* ---------- STRATEGY ENV ---------- */
const BUY_WINDOW_MS        = parseInt(process.env.BUY_WINDOW_MS || '2500', 10);
const MIN_BUYS             = parseInt(process.env.MIN_BUYS || '10', 10);
const MIN_UNIQUE           = parseInt(process.env.MIN_UNIQUE || '8', 10);
const MIN_BUY_SELL_RATIO   = parseFloat(process.env.MIN_BUY_SELL_RATIO || '3.0');
const MIN_LIQ_SOL          = parseFloat(process.env.MIN_LIQ_SOL || '0.30');
const MAX_LIQ_SOL          = parseFloat(process.env.MAX_LIQ_SOL || '5.0');

const REQUIRE_WHALE        = (process.env.REQUIRE_WHALE || 'true').toLowerCase() === 'true';
const MIN_WHALE_SHARE      = parseFloat(process.env.MIN_WHALE_SHARE || '0.15'); // 15%
const MAX_WHALE_SHARE      = parseFloat(process.env.MAX_WHALE_SHARE || '0.40'); // 40%
const WHALE_SOL_ALERT      = parseFloat(process.env.WHALE_SOL_ALERT || '0.5');  // ~0.5 SOL in window
const BUY_COOLDOWN_MS      = parseInt(process.env.BUY_COOLDOWN_MS || '30000', 10);

const SHOW_BUYERS          = (process.env.SHOW_BUYERS || 'true').toLowerCase() === 'true';
const TOP_BUYERS           = parseInt(process.env.TOP_BUYERS || '3', 10);

/* ---------- (Optional) Daily cap ---------- */
const DAILY_MAX_BUYS       = parseInt(process.env.DAILY_MAX_BUYS || '0', 10);   // 0 = ignore
let buysToday = 0;
let dayStamp  = new Date().toISOString().slice(0,10);
function rotateDayIfNeeded(){
  const d = new Date().toISOString().slice(0,10);
  if (d !== dayStamp) { dayStamp = d; buysToday = 0; console.log('[DAY RESET]', d); }
}

/* ---------- Lightning (optional) ---------- */
const USE_LIGHTNING        = (process.env.USE_LIGHTNING || 'false').toLowerCase() === 'true';
const PP_API_KEY           = process.env.PP_API_KEY || '';

console.log('[ENV] RPC_URL=', RPC_URL);
console.log('[ENV] PUBLIC_KEY set=', !!PUBKEY, 'USE_LIGHTNING=', USE_LIGHTNING);

/* ---------- Connections / signer ---------- */
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const httpAgent = new Agent({ keepAlive: true, keepAliveTimeout: 60e3, keepAliveMaxTimeout: 60e3 });

let signer = null;
if (!USE_LIGHTNING) {
  if (!PUBKEY || !SECRET) {
    console.error('Secrets not set! Need PUBLIC_KEY & WALLET_PRIVATE_KEY (local mode).');
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

/* ---------- State ---------- */
const WS_URL = 'wss://pumpportal.fun/api/data';
const pos = new Map();      // mint -> { entryCostSol, tokenQty, peakExitVal? }
const watch = new Map();    // mint -> { start, timer, buys, sells, buyers Map(addr->{tok,sol}), lastVSol }
let lastBuyAt = 0;

/* ---------- Helpers ---------- */
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

/* ---------- Trade (local / lightning) ---------- */
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
          // parse JSON b64 or retry as FORM
          try {
            const j = await r.json();
            const b64 = j?.transaction || j?.tx || j?.data;
            if (b64) bytes = Buffer.from(b64, 'base64');
          } catch {
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
        console.error('[tradeLocal]', url, 'attempt', attempt, e?.message || e);
        if (e && e.cause) console.error('[cause]', e.cause);
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
  }
  return null;
}

async function tradeLightning(body) {
  const url = `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(PP_API_KEY)}`;
  const payload = {
    action: body.action,
    mint: body.mint,
    amount: body.amount,
    denominatedInSol: body.denominatedInSol, // "true" | "false"
    slippage: body.slippage,
    priorityFee: body.priorityFee,
    pool: body.pool || 'auto',
    skipPreflight: 'true'
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Minimal headers, no custom agent (to avoid TLS/proxy issues on hosts)
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch {}

      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,200)}`);

      const sig = j?.signature || j?.txSig || null;
      if (!sig) throw new Error(`No signature in response: ${text.slice(0,200)}`);

      console.log('[TRADE OK LGT]', body.action, 'mint=', body.mint, 'sig=', sig);
      return sig;
    } catch (e) {
      console.error('[tradeLightning]', attempt, e?.message || e);
      if (e && e.cause) console.error('[cause]', e.cause);
      // Fallback: try form-encoded once after 2nd attempt
      if (attempt === 2) {
        try {
          const form = new URLSearchParams(Object.entries(payload).map(([k,v]) => [k, String(v)]));
          const r2 = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: form.toString()
          });
          const txt2 = await r2.text();
          let j2; try { j2 = JSON.parse(txt2); } catch {}
          if (r2.ok && (j2?.signature || j2?.txSig)) {
            const sig2 = j2.signature || j2.txSig;
            console.log('[TRADE OK LGT/F]', body.action, 'mint=', body.mint, 'sig=', sig2);
            return sig2;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  return null;
}

async function trade(body) { return USE_LIGHTNING ? await tradeLightning(body) : await tradeLocal(body); }

/* ---------- Watch window (orderflow scoring) ---------- */
function startWatch(m) {
  const mint = m.mint;
  if (watch.has(mint)) return;
  const rec = {
    start: Date.now(),
    buys: 0, sells: 0,
    buyers: new Map(),                 // addr -> { tok, sol }
    lastVSol: +m?.vSolInBondingCurve || 0,
    timer: setTimeout(() => evaluateMint(mint), BUY_WINDOW_MS)
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
    const gotTok = Number(m.tokenAmount || 0);
    if (gotTok > 0) {
      const spt = estSolPerToken(m);
      const prev = rec.buyers.get(addr) || { tok: 0, sol: 0 };
      prev.tok += gotTok;
      if (spt) prev.sol += gotTok * spt;
      rec.buyers.set(addr, prev);
    }
  }
  if (m.txType === 'sell') rec.sells++;
  if (+m?.vSolInBondingCurve > 0) rec.lastVSol = +m.vSolInBondingCurve;
}
function evaluateMint(mint) {
  const rec = watch.get(mint);
  if (!rec) return;
  watch.delete(mint);

  const buys   = rec.buys;
  const sells  = rec.sells;
  const unique = rec.buyers.size;
  const ratio  = buys / Math.max(1, sells);
  const vsol   = rec.lastVSol;

  // whale share (by tokens)
  let totalTok = 0, maxTok = 0, whaleAddr = null;
  for (const [addr, v] of rec.buyers.entries()) {
    totalTok += v.tok;
    if (v.tok > maxTok) { maxTok = v.tok; whaleAddr = addr; }
  }
  const whaleShare = totalTok > 0 ? (maxTok / totalTok) : 0;

  // top buyers by est SOL
  const arr = [...rec.buyers.entries()].map(([addr, v]) => ({
    addr, tok: v.tok, sol: v.sol || 0
  })).sort((a,b)=> (b.sol - a.sol) || (b.tok - a.tok));

  if (SHOW_BUYERS) {
    const top = arr.slice(0, Math.max(1, TOP_BUYERS))
      .map(x => `${x.addr.slice(0,6)}…${x.addr.slice(-4)} ~${x.sol.toFixed(3)} SOL`)
      .join(', ');
    console.log('[BUYERS]', mint, 'top:', top || '—');
  }
  const topBySol = arr[0]?.sol || 0;
  if ((whaleShare >= MIN_WHALE_SHARE && topBySol >= WHALE_SOL_ALERT) || whaleShare >= MAX_WHALE_SHARE) {
    console.log('[WHALE]', mint, 'share=', (whaleShare*100).toFixed(1)+'%', 'top≈', topBySol.toFixed(3), 'SOL');
  }

  // gates + score
  const whaleGate = REQUIRE_WHALE
    ? (whaleShare >= MIN_WHALE_SHARE && whaleShare <= MAX_WHALE_SHARE)
    : (whaleShare <= MAX_WHALE_SHARE);

  const gates =
    buys   >= MIN_BUYS &&
    unique >= MIN_UNIQUE &&
    ratio  >= MIN_BUY_SELL_RATIO &&
    vsol   >= MIN_LIQ_SOL && vsol <= MAX_LIQ_SOL &&
    whaleGate;

  // composite score (0..1)
  const f = (x, t) => Math.min(1, x / t);
  const vsolOK = (vsol >= MIN_LIQ_SOL && vsol <= MAX_LIQ_SOL) ? 1 : 0;
  const whalePenalty = 1 - Math.min(1, whaleShare / Math.max(1e-9, MAX_WHALE_SHARE)); // bigger share => lower score
  const score =
    0.25 * f(buys,   MIN_BUYS) +
    0.25 * f(unique, MIN_UNIQUE) +
    0.20 * f(ratio,  MIN_BUY_SELL_RATIO) +
    0.20 * whalePenalty +
    0.10 * vsolOK;

  console.log('[SCORE]', mint, 'buys=', buys, 'unique=', unique,
              'ratio=', ratio.toFixed(2), 'vsol=', vsol.toFixed(2),
              'whale=', (whaleShare*100).toFixed(1)+'%', '→', score.toFixed(2));

  if (!gates) { console.log('[SKIP]', mint, 'gates fail'); return; }
  if (Date.now() - lastBuyAt < BUY_COOLDOWN_MS) { console.log('[SKIP] cooldown'); return; }

  rotateDayIfNeeded();
  if (DAILY_MAX_BUYS > 0 && buysToday >= DAILY_MAX_BUYS) { console.log('[SKIP] daily max buys reached'); return; }

  instantBuy(mint);
}

/* ---------- Buy/Sell ---------- */
async function instantBuy(mint) {
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
    pos.set(mint, { entryCostSol: BUY_SOL + PRIORITY_FEE, tokenQty: 0, peakExitVal: 0 });
    lastBuyAt = Date.now();
    rotateDayIfNeeded();
    buysToday += 1;
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

/* ---------- WS subscribe/unsubscribe per mint ---------- */
function subscribeMintForWindow(ws, mint) {
  ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
  setTimeout(() => {
    ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
  }, BUY_WINDOW_MS + 500);
}

/* ---------- WebSocket loop ---------- */
function openWS() {
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false });

  ws.on('open', () => {
    console.log('[WS] Connected');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [PUBKEY] }));
  });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }

    // New token → start observation + subscribe its trades
    if (m?.txType === 'create' && m?.mint) {
      console.log('[NEW TOKEN]', m.mint);
      startWatch(m);
      subscribeMintForWindow(ws, m.mint);
      return;
    }

    // Update watch with incoming trades
    if (m?.mint && watch.has(m.mint)) updateWatch(m);

    // Our account fills
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

    // Price ticks → TP/SL
    if (m?.mint && pos.has(m.mint)) {
      const p = pos.get(m.mint);
      if (!p?.tokenQty) return;
      const spt = estSolPerToken(m); if (!spt) return;
      const estExit = spt * p.tokenQty;
      p.peakExitVal = Math.max(p.peakExitVal || 0, estExit);

      const tp = p.entryCostSol * (1 + TAKE_PROFIT);
      const sl = p.entryCostSol * (1 - STOP_LOSS);

      if (estExit >= tp) {
        console.log('[TP HIT]', m.mint, 'exit≈', estExit.toFixed(4), 'target≈', tp.toFixed(4));
        sellAll(m.mint);
      } else if (estExit <= sl) {
        console.log('[SL HIT]', m.mint, 'exit≈', estExit.toFixed(4), 'stop≈', sl.toFixed(4));
        sellAll(m.mint);
      }
    }
  });

  ws.on('close', () => { console.error('[WS] Closed → reconnecting...'); setTimeout(openWS, 1000); });
  ws.on('error', (e) => console.error('[WS error]', e?.message || e));
}

openWS();
setInterval(() => {}, 1e9); // keep process alive
