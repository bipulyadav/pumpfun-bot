// ============= OLD-TOKEN MOMENTUM BOT (Lightning mode) =============
// Scans DexScreener boosted Solana tokens, filters by momentum & liquidity,
// buys via PumpPortal Lightning, exits on +20% TP / trailing / TTL (no hard SL).
// -------------------------------------------------------------------

import 'dotenv/config';
import { fetch } from 'undici';
import { Connection, PublicKey } from '@solana/web3.js';

// ---------- ENV ----------
const RPC_URL       = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const USE_LIGHTNING = (process.env.USE_LIGHTNING || 'true').toLowerCase() === 'true';
const PP_API_KEY    = process.env.PP_API_KEY || '';
const PUBLIC_KEY    = process.env.PUBLIC_KEY || '';          // Lightning wallet pubkey (FUND THIS)

if (!USE_LIGHTNING) {
  console.error('This build is Lightning-only. Set USE_LIGHTNING=true.');
  setInterval(() => {}, 1e9);
}
if (!PP_API_KEY || !PUBLIC_KEY) {
  console.error('Missing PP_API_KEY or PUBLIC_KEY (Lightning wallet).');
  setInterval(() => {}, 1e9);
}

// sizing & fees
const BUY_SOL        = parseFloat(process.env.BUY_SOL || '0.0010');   // ~ $0.18–0.25
const SLIPPAGE       = parseInt(process.env.SLIPPAGE || '10', 10);
const PRIORITY_FEE   = parseFloat(process.env.PRIORITY_FEE || '0.0000');

// exits (NO hard SL)
const TAKE_PROFIT    = parseFloat(process.env.TAKE_PROFIT_PCT || '20') / 100; // 20%
const TRAIL_AFTER_HIT= (process.env.TRAIL_AFTER_HIT || 'true').toLowerCase() === 'true';
const TRAIL_PCT      = parseFloat(process.env.TRAIL_PCT || '12') / 100;       // 12% from peak after TP
const HOLD_MAX_MS    = parseInt(process.env.HOLD_MAX_MS || '420000', 10);     // 7 min TTL
const TTL_MIN_PROFIT = parseFloat(process.env.TTL_MIN_PROFIT_PCT || '5')/100; // +5% req by TTL

// momentum filters (DexScreener)
const BOOST_POLL_MS  = parseInt(process.env.BOOST_POLL_MS || '20000', 10);    // poll boosts each 20s
const MIN_5M_CHANGE  = parseFloat(process.env.MIN_5M_CHANGE || '15');         // ≥+15% in 5m
const MIN_5M_BUYS    = parseInt(process.env.MIN_5M_BUYS || '30', 10);         // ≥30 buys last 5m
const MIN_BUY_SELL_R = parseFloat(process.env.MIN_BUY_SELL_R || '3.0');       // ≥3x buys/sells
const MIN_LIQ_USD    = parseFloat(process.env.MIN_LIQ_USD || '30000');        // $30k ≤ liq
const MAX_LIQ_USD    = parseFloat(process.env.MAX_LIQ_USD || '250000');       // liq ≤ $250k
const MIN_VOL_5M_USD = parseFloat(process.env.MIN_VOL_5M_USD || '7000');      // ≥$7k vol 5m

// risk: throttles
const DAILY_MAX_BUYS = parseInt(process.env.DAILY_MAX_BUYS || '6', 10);
const BUY_COOLDOWN_MS= parseInt(process.env.BUY_COOLDOWN_MS || '60000', 10);  // 1 min

// constants
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DS_BASE  = 'https://api.dexscreener.com';
const PUMP_LGT = 'https://pumpportal.fun/api/trade';

console.log('[ENV] Lightning=true, BUY_SOL=', BUY_SOL, 'TP=', TAKE_PROFIT, 'TRAIL=', TRAIL_PCT);

// ---------- state ----------
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const lightningPubkey = new PublicKey(PUBLIC_KEY);

let buysToday = 0;
let dayStamp  = new Date().toISOString().slice(0,10);
let lastBuyAt = 0;

// mint -> pos
// pos: { pairAddress, entryCostSol, tokenQty, peakExitVal, tpSeen, openedAt }
const positions = new Map();
// to avoid re-buy spam per token
const attempted = new Set();

// ---------- utils ----------
function rotateDayIfNeeded(){
  const d = new Date().toISOString().slice(0,10);
  if (d !== dayStamp) { dayStamp = d; buysToday = 0; console.log('[DAY RESET]', d); }
}
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function getJson(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return await r.json();
}
async function postJson(url, body, extraHeaders={}){
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status}: ${text.slice(0,200)}`);
  return j ?? {};
}
async function ensureQtyFromChain(mint) {
  try {
    const res = await conn.getParsedTokenAccountsByOwner(
      lightningPubkey, { mint: new PublicKey(mint) }, 'confirmed'
    );
    const acct = res?.value?.[0];
    const amt  = acct?.account?.data?.parsed?.info?.tokenAmount;
    const uiQ  = amt?.uiAmount || 0;
    return uiQ;
  } catch (e) {
    console.error('[QTY ERR]', e?.message || e); return 0;
  }
}

// ---------- trade via Lightning ----------
async function tradeLightning({ action, mint, amount, denomSol=true, slippage=SLIPPAGE, priority=PRIORITY_FEE }){
  const url = `${PUMP_LGT}?api-key=${encodeURIComponent(PP_API_KEY)}`;
  const payload = {
    action, mint, amount,
    denominatedInSol: denomSol ? 'true' : 'false',
    slippage, priorityFee: priority, pool: 'auto', skipPreflight: 'true'
  };
  const j = await postJson(url, payload, { 'x-api-key': PP_API_KEY });
  const sig = j?.signature || j?.txSig;
  if (!sig) throw new Error(`No signature in Lightning response: ${JSON.stringify(j).slice(0,200)}`);
  console.log('[TRADE OK LGT]', action, mint, 'sig=', sig);
  return sig;
}

// ---------- momentum scan (DexScreener boosts -> pairs) ----------
async function fetchBoostedSolanaMints(){
  // token-boosts: list of boosted tokens across chains
  const boosts = await getJson(`${DS_BASE}/token-boosts/latest/v1`);
  const rows = Array.isArray(boosts) ? boosts : (boosts?.tokens || boosts?.data || []);
  const sols = rows.filter(x => (x?.chainId || '').toLowerCase() === 'solana');
  const set = new Set();
  for (const r of sols) {
    const t = r.tokenAddress || r.address || r.token;
    if (t) set.add(t);
  }
  return [...set];
}

function pickBestSolPair(pairs){
  // choose SOL-quoted pair with decent liquidity and recent activity
  const sols = pairs.filter(p => p?.quoteToken?.address === SOL_MINT);
  if (sols.length === 0) return null;

  const scored = sols.map(p => {
    const ch5  = +p?.priceChange?.m5 || 0;
    const vol5 = +p?.volume?.m5 || 0;
    const buys = +p?.txns?.m5?.buys || 0;
    const sells= +p?.txns?.m5?.sells || 0;
    const liq  = +p?.liquidity?.usd || 0;
    const ratio= buys / Math.max(1, sells);
    let score  = 0;
    if (ch5 >= MIN_5M_CHANGE) score += 1;
    if (vol5 >= MIN_VOL_5M_USD) score += 1;
    if (buys >= MIN_5M_BUYS) score += 1;
    if (ratio >= MIN_BUY_SELL_R) score += 1;
    if (liq >= MIN_LIQ_USD && liq <= MAX_LIQ_USD) score += 1;
    return { p, score, ch5, vol5, buys, ratio, liq };
  }).sort((a,b)=> b.score - a.score || b.ch5 - a.ch5);

  const best = scored[0];
  if (!best || best.score < 4) return null; // need at least 4/5 signals
  return best.p;
}

async function scanAndMaybeBuy(){
  try {
    rotateDayIfNeeded();
    if (DAILY_MAX_BUYS > 0 && buysToday >= DAILY_MAX_BUYS) return;

    const now = Date.now();
    if (now - lastBuyAt < BUY_COOLDOWN_MS) return;

    const mints = await fetchBoostedSolanaMints();
    for (const mint of mints) {
      if (attempted.has(mint)) continue;

      // pools for this mint (use latest/dex/tokens -> pairs array)
      const toks = await getJson(`${DS_BASE}/latest/dex/tokens/solana/${mint}`);
      const pairs = Array.isArray(toks?.pairs) ? toks.pairs : [];
      const best = pickBestSolPair(pairs);
      if (!best) continue;

      const baseMint = best?.baseToken?.address;
      const pairAddr = best?.pairAddress;
      const ch5  = +best?.priceChange?.m5 || 0;
      const vol5 = +best?.volume?.m5 || 0;
      const buys = +best?.txns?.m5?.buys || 0;
      const sells= +best?.txns?.m5?.sells || 0;
      const liq  = +best?.liquidity?.usd || 0;

      console.log('[CANDIDATE]', baseMint, 'pair=', pairAddr,
        `5m%=${ch5} vol5=$${vol5} buys=${buys}/${sells} liq=$${liq}`);

      // buy
      try {
        await tradeLightning({ action: 'buy', mint: baseMint, amount: BUY_SOL });
      } catch (e) {
        console.error('[BUY FAIL]', baseMint, e?.message || e);
        attempted.add(mint); // avoid re-spam
        continue;
      }

      lastBuyAt = Date.now();
      buysToday += 1;
      attempted.add(mint);

      // set up position tracking
      positions.set(baseMint, {
        pairAddress: pairAddr,
        entryCostSol: BUY_SOL + PRIORITY_FEE,
        tokenQty: 0, peakExitVal: 0, tpSeen: false, openedAt: Date.now()
      });

      // fetch token qty from chain (Lightning fills may not appear in WS)
      const qty = await ensureQtyFromChain(baseMint);
      const pos = positions.get(baseMint);
      if (pos) { pos.tokenQty = qty; console.log('[POSITION/CHAIN]', baseMint, 'qty=', qty); }

      // start monitor loop (detached)
      monitorPosition(baseMint).catch(()=>{});
      if (DAILY_MAX_BUYS > 0 && buysToday >= DAILY_MAX_BUYS) break;
    }
  } catch (e) {
    console.error('[SCAN ERR]', e?.message || e);
  }
}

// ---------- monitor positions using DexScreener pair price ----------
async function fetchPair(chainPair){
  const j = await getJson(`${DS_BASE}/latest/dex/pairs/solana/${chainPair}`);
  const p = j?.pairs?.[0];
  return p || null; // includes priceNative, txns, liquidity, priceChange, etc.
}

async function monitorPosition(mint){
  const pos = positions.get(mint);
  if (!pos) return;

  const { pairAddress } = pos;
  if (!pairAddress) { console.warn('[MONITOR] no pair for', mint); return; }

  while (positions.has(mint)) {
    try {
      // need qty; if not yet present, try once more
      if (!pos.tokenQty || pos.tokenQty <= 0) {
        const q = await ensureQtyFromChain(mint);
        if (q > 0) { pos.tokenQty = q; console.log('[POSITION/CHAIN]', mint, 'qty=', q); }
      }

      const pair = await fetchPair(pairAddress);
      const priceNative = +pair?.priceNative || 0; // in SOL (because quote=SOL)
      if (priceNative <= 0 || !pos.tokenQty) { await sleep(2500); continue; }

      const estExit = priceNative * pos.tokenQty; // SOL value
      pos.peakExitVal = Math.max(pos.peakExitVal || 0, estExit);

      const tp = pos.entryCostSol * (1 + TAKE_PROFIT);

      // TP: book profits immediately (+20%)
      if (estExit >= tp) {
        pos.tpSeen = true;
        console.log('[TP HIT]', mint, 'exit≈', estExit.toFixed(4), 'tp≈', tp.toFixed(4));
        await sellAll(mint);
        break;
      }

      // Trailing after TP seen once (if enabled)
      if (TRAIL_AFTER_HIT && pos.tpSeen && pos.peakExitVal > 0) {
        const trailFloor = pos.peakExitVal * (1 - TRAIL_PCT);
        if (estExit <= trailFloor) {
          console.log('[TRAIL SELL]', mint,
            'est≈', estExit.toFixed(4),
            'floor≈', trailFloor.toFixed(4),
            'peak≈', pos.peakExitVal.toFixed(4));
          await sellAll(mint);
          break;
        }
      }

      // TTL: if +5% not achieved by HOLD_MAX_MS, exit flat/near-flat
      const age = Date.now() - (pos.openedAt || Date.now());
      const ttlTarget = pos.entryCostSol * (1 + TTL_MIN_PROFIT);
      if (age >= HOLD_MAX_MS && estExit < ttlTarget) {
        console.log('[TTL EXIT]', mint, 'age=', (age/1000).toFixed(0)+'s',
          'est≈', estExit.toFixed(4), 'need≥', ttlTarget.toFixed(4));
        await sellAll(mint);
        break;
      }

    } catch (e) {
      console.error('[MONITOR ERR]', mint, e?.message || e);
    }
    await sleep(2500);
  }
}

async function sellAll(mint){
  try {
    await tradeLightning({ action: 'sell', mint, amount: '100%', denomSol: false });
  } catch (e) {
    console.error('[SELL FAIL]', mint, e?.message || e);
    return;
  }
  positions.delete(mint);
}

// ---------- main loop ----------
console.log('[START] Old-token momentum mode (DexScreener boosts)');
setInterval(scanAndMaybeBuy, BOOST_POLL_MS);
scanAndMaybeBuy(); // kick immediately

// keep alive
setInterval(()=>{}, 1e9);
