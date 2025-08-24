require('dotenv').config();
const WebSocket = require('ws');
const { decode, encode } = require('bs58');  // ✅ bs58 fix
const { fetch, Agent } = require('undici');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');

// ---- ENV VARS ----
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBKEY = process.env.PUBLIC_KEY;
const SECRET = process.env.WALLET_PRIVATE_KEY;
const BUY_SOL = parseFloat(process.env.BUY_SOL || '0.005');
const SLIPPAGE = parseInt(process.env.SLIPPAGE || '15', 10);
const PRIORITY_FEE = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const TAKE_PROFIT = parseFloat(process.env.TAKE_PROFIT_PCT || '50') / 100;

// ---- BASIC CHECK ----
if (!PUBKEY || !SECRET) {
  console.error('Secrets not set! Check PUBLIC_KEY & WALLET_PRIVATE_KEY env vars.');
  setInterval(() => {}, 1e9); // keep alive for logs
}

// ✅ decode bs58 private key
const signer = Keypair.fromSecretKey(decode(SECRET));
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const httpAgent = new Agent({
  keepAliveTimeout: 60e3,
  keepAliveMaxTimeout: 60e3,
  keepAlive: true,
});

const WS_URL = 'wss://pumpportal.fun/api/data';
const pos = new Map(); // mint -> { entryCostSol, tokenQty }

// ---- HELPERS ----
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
        dispatcher: httpAgent,
      });

      // Try raw bytes first
      let bytes;
      try {
        const ab = await r.arrayBuffer();
        const u8 = new Uint8Array(ab);
        if (u8.length > 0) bytes = u8;
      } catch (_) {}

      // Fallback to JSON base64
      if (!bytes) {
        const j = await r.json().catch(() => null);
        const b64 = j?.transaction || j?.tx || j?.data;
        if (!b64) throw new Error(`trade-local parse fail (status ${r.status})`);
        bytes = Buffer.from(b64, 'base64');
      }

      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([signer]);
      const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
      console.log('[TRADE]', body.action, 'mint=', body.mint, 'sig=', sig);
      return sig;
    } catch (e) {
      console.error('[tradeOnce]', attempt, e?.message || e);
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  return null; // never throw
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
    pool: 'auto',
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
    pool: 'auto',
  };
  await tradeOnce(body);
  pos.delete(mint);
}

// ---- WEBSOCKET HANDLER ----
function openWS() {
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false });

  ws.on('open', () => {
    console.log('[WS] Connected.');
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [PUBKEY] }));
  });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }

    // New token → instant buy
    if (m?.txType === 'create' && m?.mint) {
      console.log('[NEW TOKEN]', m.mint);
      instantBuy(m.mint);
      return;
    }

    // Our trades
    if (m?.traderPublicKey === PUBKEY && m?.mint) {
      const p = pos.get(m.mint);
      if (p) {
        if (m.txType === 'buy') {
          const got = Number(m.tokenAmount || m.newTokenBalance || 0);
          if (got > 0 && p.tokenQty === 0) {
            p.tokenQty = got;
            console.log('[POSITION] Tokens acquired:', got);
          }
        }
        if (m.txType === 'sell') {
          pos.delete(m.mint);
          console.log('[POSITION] Sold all for mint', m.mint);
        }
      }
      return;
    }

    // Price tracking → take profit
    if (m?.mint && pos.has(m.mint)) {
      const p = pos.get(m.mint);
      if (!p?.tokenQty) return;
      const spt = estSolPerToken(m);
      if (!spt) return;
      const estExit = spt * p.tokenQty;
      const target = p.entryCostSol * (1 + TAKE_PROFIT);
      if (estExit >= target) {
        console.log('[TAKE PROFIT] Mint=', m.mint, 'Exit=', estExit.toFixed(4));
        sellAll(m.mint);
      }
    }
  });

  ws.on('close', () => {
    console.error('[WS] Closed. Reconnecting...');
    setTimeout(openWS, 1000);
  });
  ws.on('error', (e) => {
    console.error('[WS error]', e?.message || e);
  });
}

openWS();

// keep alive
setInterval(() => {}, 1e9);
