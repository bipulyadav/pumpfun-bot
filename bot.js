 import 'dotenv/config';
import WebSocket from 'ws';
import bs58 from 'bs58';
import { fetch, Agent } from 'undici';
import {
  Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL
} from '@solana/web3.js';

// ====== ENV ======
const RPC_URL       = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBKEY        = process.env.PUBLIC_KEY;               // Local: your wallet | Lightning: lightning wallet pubkey
const SECRET        = process.env.WALLET_PRIVATE_KEY;       // Local only (bs58)
const BUY_SOL       = parseFloat(process.env.BUY_SOL || '0.005');
const SLIPPAGE      = parseInt(process.env.SLIPPAGE || '15', 10);
const PRIORITY_FEE  = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const TAKE_PROFIT   = parseFloat(process.env.TAKE_PROFIT_PCT || '50') / 100;

// Optional Lightning mode
const USE_LIGHTNING = (process.env.USE_LIGHTNING || 'false').toLowerCase() === 'true';
const PP_API_KEY    = process.env.PP_API_KEY || '';

// Quick env echo
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
    setInterval(() => {}, 1e9); // keep alive so you can read logs
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
const pos = new Map(); // mint -> { entryCostSol, tokenQty }

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

// ====== HTTP helpers ======
const COMMON_HEADERS = {
  accept: '*/*',
  'user-agent': 'pump-bot/1.0',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/'
};

async function postJson(url, body) {
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...COMMON_HEADERS },
    body: JSON.stringify(body),
    dispatcher: httpAgent
  });
}

async function postForm(url, body) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.append(k, String(v));
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...COMMON_HEADERS },
    body: form.toString(),
    dispatcher: httpAgent
  });
}

// ====== TRADE (LOCAL) ======
const TRADE_ENDPOINTS = [
  process.env.TRADE_URL || 'https://pumpportal.fun/api/trade-local',
  'https://www.pumpportal.fun/api/trade-local',
];

async function tradeLocal(body) {
  for (const url of TRADE_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Try JSON first
        let r = await postJson(url, body);
        let bytes;

        try {
          const ab = await r.arrayBuffer();
          const u8 = new Uint8Array(ab);
          if (u8.length > 0) bytes = u8;
        } catch {}

        if (!bytes) {
          // If JSON body didn’t return bytes, try to parse base64
          try {
            const j = await r.json();
            const b64 = j?.transaction || j?.tx || j?.data;
            if (b64) bytes = Buffer.from(b64, 'base64');
          } catch {
            // Try FORM path
            r = await postForm(url, body);
            try {
              const ab2 = await r.arrayBuffer();
              const u82 = new Uint8Array(ab2);
              if (u82.length > 0) bytes = u82;
            } catch {}
            if (!bytes) {
              const j2 = await r.json().catch(() => null);
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

// ====== TRADE (LIGHTNING) ======
const TRADE_LIGHTNING = `https://pumpportal.fun/api/trade?api-key=${PP_API_KEY}`;

async function tradeLightning(body) {
  const payload = {
    action: body.action,
    mint: body.mint,
    amount: body.amount,
    denominatedInSol: body.denominatedInSol,
    slippage: body.slippage,
    priorityFee: body.priorityFee,
    pool: body.pool || 'auto',
    skipPreflight: 'true'
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await postJson(TRADE_LIGHTNING, payload);
      const j = await r.json().catch(() => null);
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

// Unified trade
async function trade(body) {
  return USE_LIGHTNING ? await tradeLightning(body) : await tradeLocal(body);
}

// ====== BUY / SELL ======
async function instantBuy(mint) {
  if (!USE_LIGHTNING) {
    const bal = await logAndGetBalance();
    const need = (BUY_SOL || 0) + (PRIORITY_FEE || 0) + 0.002; // cushion
    if (typeof bal === 'number' && bal < need) {
      console.error('[SKIP BUY] Low balance. have=', (bal||0).toFixed(4), 'need≈', need.toFixed(4));
      return;
    }
  }
  const body = {
    publicKey: PUBKEY,               // ignored by Lightning
    action: 'buy',
    mint,
    amount: BUY_SOL,
    denominatedInSol: 'true',
    slippage: SLIPPAGE,
    priorityFee: PRIORITY_FEE,
    pool: 'auto'
  };
  const sig = await trade(body);
  if (sig) pos.set(mint, { entryCostSol: BUY_SOL + PRIORITY_FEE, tokenQty: 0 });
}

async function sellAll(mint) {
  const body = {
    publicKey: PUBKEY,               // ignored by Lightning
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: 'false',
    slippage: SLIPPAGE,
    priorityFee: PRIORITY_FEE,
    pool: 'auto'
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

    // 1) New token → instant buy
    if (m?.txType === 'create' && m?.mint) {
      console.log('[NEW TOKEN]', m.mint);
      instantBuy(m.mint);
      return;
    }

    // 2) Our fills
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

    // 3) Price ticks → TP
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

  ws.on('close', () => {
    console.error('[WS] Closed → reconnecting...');
    setTimeout(openWS, 1000);
  });
  ws.on('error', (e) => console.error('[WS error]', e?.message || e));
}

openWS();
setInterval(() => {}, 1e9); // keep process alive
