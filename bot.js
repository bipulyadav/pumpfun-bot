 import 'dotenv/config';
import WebSocket from 'ws';
import bs58 from 'bs58';                         // ✅ ESM import (bs58 v6)
import { fetch, Agent } from 'undici';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

// ---- ENV VARS ----
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBKEY  = process.env.PUBLIC_KEY;
const SECRET  = process.env.WALLET_PRIVATE_KEY;
const BUY_SOL = parseFloat(process.env.BUY_SOL || '0.005');
const SLIPPAGE = parseInt(process.env.SLIPPAGE || '15', 10);
const PRIORITY_FEE = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const TAKE_PROFIT  = parseFloat(process.env.TAKE_PROFIT_PCT || '50') / 100;

// Quick env check
console.log('[ENV] PUBLIC_KEY set:', !!PUBKEY);
console.log('[ENV] WALLET_PRIVATE_KEY set:', !!SECRET);
console.log('[ENV] RPC_URL:', RPC_URL);

if (!PUBKEY || !SECRET) {
  console.error('Secrets not set! Check PUBLIC_KEY & WALLET_PRIVATE_KEY in Railway Environments → Production.');
  // Keep process alive so you can read logs
  setInterval(() => {}, 1e9);
}

// ✅ decode bs58 private key (ESM bs58)
const signer = Keypair.fromSecretKey(bs58.decode(SECRET));
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const httpAgent = new Agent({ keepAlive: true, keepAliveTimeout: 60e3, keepAliveMaxTimeout: 60e3 });

const WS_URL = 'wss://pumpportal.fun/api/data';
const pos = new Map(); // mint -> { entryCostSol, tokenQty }

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException',  e => console.error('[uncaughtException]',  e?.message || e));

function estSolPerToken(m) {
  const vs = +m?.vSolInBondingCurve, vt = +m?.vTokensInBondingCurve;
  return (vs > 0 && vt > 0) ? (vs / vt) : null;
}

async function tradeOnce(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch('https://pumpportal.fun/api/trade-local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        dispatcher: httpAgent
      });

      let bytes;
      try {
        const ab = await r.arrayBuffer();
        const u8 = new Uint8Array(ab);
        if (u8.length > 0) bytes = u8; // raw bytes path
      } catch {}

      if (!bytes) {
        const j = await r.json().catch(() => null);
        const b64 = j?.transaction || j?.tx || j?.data;
        if (!b64) throw new Error(`trade-local parse fail (status ${r.status})`);
        bytes = Buffer.from(b64, 'base64');      // JSON base64 fallback
      }

      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([signer]);
      const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
      console.log('[TRADE]', body.action, 'mint=', body.mint, 'sig=', sig);
      return sig;
    } catch (e) {
      console.error('[tradeOnce attempt', attempt, ']', e?.message || e);
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  return null; // never throw → process alive
}

async function instantBuy(mint) {
  const body = {
    publicKey: PUBKEY,
    action: 'buy',
    mint,
    amount: BUY_SOL,
    denominatedInSol: 'true',
    slippage: SLIPPAGE,
    priorityFee: PRIORITY_FEE,
    pool: 'auto'
  };
  const sig = await tradeOnce(body);
  if (sig) pos.set(mint, { entryCostSol: BUY_SOL + PRIORITY_FEE, tokenQty: 0 });
}

async function sellAll(mint) {
  const body = {
    publicKey: PUBKEY,
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: 'false',
    slippage: SLIPPAGE,
    priorityFee: PRIORITY_FEE,
    pool: 'auto'
  };
  await tradeOnce(body);
  pos.delete(mint);
}

function openWS() {
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false });

  ws.on('open', () => {
    console.log('[WS] Connected');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [PUBKEY] }));
  });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }

    // 1) New token => instant buy
    if (m?.txType === 'create' && m?.mint) {
      console.log('[NEW TOKEN]', m.mint);
      instantBuy(m.mint);
      return;
    }

    // 2) Our account trades (fills)
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

    // 3) Price ticks → take-profit
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

// keep the process alive
setInterval(() => {}, 1e9);
