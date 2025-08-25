// ================= OLD-TOKEN MOMENTUM BOT (Lightning mode) =================
// - Scans DexScreener boosted Solana tokens
// - Picks supported DEX pairs (Raydium/Pump/Bonk/LaunchLab), SOL or USDC quotes
// - Buys via PumpPortal Lightning with correct `pool`
// - Exits: +20% TP, trailing after TP, TTL exit if no min profit (NO hard SL)
// - 429-safe: NO Solana RPC calls; token qty is estimated from entry price
// ===========================================================================

import 'dotenv/config';
import { fetch } from 'undici';

/* ---------- ENV ---------- */
const USE_LIGHTNING = (process.env.USE_LIGHTNING || 'true').toLowerCase() === 'true';
const PP_API_KEY    = process.env.PP_API_KEY || '';
const PUBLIC_KEY    = process.env.PUBLIC_KEY || ''; // Lightning wallet pubkey (fund this)

if (!USE_LIGHTNING) {
  console.error('This build is Lightning-only. Set USE_LIGHTNING=true.');
  setInterval(() => {}, 1e9);
}
if (!PP_API_KEY || !PUBLIC_KEY) {
  console.error('Missing PP_API_KEY or PUBLIC_KEY (Lightning wallet).');
  setInterval(() => {}, 1e9);
}

/* sizing & fees */
const BUY_SOL        = parseFloat(process.env.BUY_SOL || '0.0010');   // ~$0.18–0.25
const SLIPPAGE       = parseInt(process.env.SLIPPAGE || '10', 10);
const PRIORITY_FEE   = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const FEE_PCT        = parseFloat(process.env.FEE_PCT || '1.2') / 100; // est. total fees/slip at entry

/* exits (NO hard SL) */
const TAKE_PROFIT    = parseFloat(process.env.TAKE_PROFIT_PCT || '20') / 100; // +20%
const TRAIL_AFTER_HIT= (process.env.TRAIL_AFTER_HIT || 'true').toLowerCase() === 'true';
const TRAIL_PCT      = parseFloat(process.env.TRAIL_PCT || '12') / 100;       // 12% from peak after TP
const HOLD_MAX_MS    = parseInt(process.env.HOLD_MAX_MS || '420000', 10);     // 7 min TTL
const TTL_MIN_PROFIT = parseFloat(process.env.TTL_MIN_PROFIT_PCT || '5')/100; // +5% req by TTL

/* momentum filters (DexScreener) */
const BOOST_POLL_MS  = parseInt(process.env.BOOST_POLL_MS || '20000', 10);    // poll boosts each 20s
const MIN_5M_CHANGE  = parseFloat(process.env.MIN_5M_CHANGE || '15');         // ≥+15% in 5m
const MIN_5M_BUYS    = parseInt(process.env.MIN_5M_BUYS || '30', 10);         // ≥30 buys last 5m
const MIN_BUY_SELL_R = parseFloat(process.env.MIN_BUY_SELL_R || '3.0');       // ≥3x buys/sells
const MIN_LIQ_USD    = parseFloat(process.env.MIN_LIQ_USD || '30000');        // $30k ≤ liq
const MAX_LIQ_USD    = parseFloat(process.env.MAX_LIQ_USD || '250000');       // liq ≤ $250k
const MIN_VOL_5M_USD = parseFloat(process.env.MIN_VOL_5M_USD || '7000');      // ≥$7k vol 5m

/* throttles */
const DAILY_MAX_BUYS = parseInt(process.env.DAILY_MAX_BUYS || '6', 10);
const BUY_COOLDOWN_MS= parseInt(process.env.BUY_COOLDOWN_MS || '60000', 10);  // 1 min

/* constants */
const DS_BASE  = 'https://api.dexscreener.com';
const PUMP_LGT = 'https://pumpportal.fun/api/trade';
const SUPPORTED_DEX = ['raydium', 'raydium-cpmm', 'pump', 'pumpfun', 'pumpswap', 'bonk', 'launchlab'];

console.log('[ENV] Lightning=true, BUY_SOL=', BUY_SOL, 'TP=', TAKE_PROFIT, 'TRAIL=', TRAIL_PCT);

/* ---------- state ---------- */
let buysToday = 0;
let dayStamp  = new Date().toISOString().slice(0,10);
let lastBuyAt = 0;

// mint -> pos
// pos: { pairAddress, entryCostSol, tokenQty, peakExitVal, tpSeen, openedAt, pool }
const positions = new Map();
// avoid re-buy spam per token id when appropriate
const attempted = new Set();

/* ---------- utils ---------- */
function rotateDayIfNeeded(){
  const d = new Date().toISOString().slice(0,10);
  if (d !== dayStamp) { dayStamp = d; buysToday = 0; console.log('[DAY RESET]', d); }
}
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function getJson(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (r.status === 429) throw new Error('429 Too Many Requests');
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

/* ---------- pool helpers ---------- */
function isSupportedDex(pair){
  const dex = (pair?.dexId || '').toLowerCase();
  return SUPPORTED_DEX.some(s => dex.includes(s));
}
function choosePoolForPair(pair){
  const dex = (pair?.dexId || '').toLowerCase();
  if (dex.includes('raydium')) return 'raydium'; // also ok for raydium-cpmm
  if (dex.includes('pump') || dex.includes('pumpfun') || dex.includes('pumpswap')) return 'pump';
  if (dex.includes('bonk')) return 'bonk';
  if (dex.includes('launchlab')) return 'launchlab';
  return 'auto';
}

/* ---------- Lightning trade (pool-aware) ---------- */
async function tradeLightning({ action, mint, amount, denomSol=true, slippage=SLIPPAGE, priority=PRIORITY_FEE, pool='auto' }){
  const url = `${PUMP_LGT}?api-key=${encodeURIComponent(PP_API_KEY)}`;
  const payload = {
    action, mint, amount,
    denominatedInSol: denomSol ? 'true' : 'false',
    slippage, priorityFee: priority,
    pool,
    skipPreflight: 'true'
  };
  const j = await postJson(url, payload, { 'x-api-key': PP_API_KEY });
  const sig = j?.signature || j?.txSig;
  if (!sig) throw new Error(`No signature in Lightning response: ${JSON.stringify(j).slice(0,200)}`);
  console.log('[TRADE OK LGT]', action, mint, 'pool=', pool, 'sig=', sig);
  return sig;
}

/* ---------- boosted IDs (skip new-mint style ids ending with ...pump) ---------- */
async function fetchBoostedSolanaMints(){
  const boosts = await getJson(`${DS_BASE}/token-boosts/latest/v1`);
  const rows = Array.isArray(boosts) ? boosts : (boosts?.tokens || boosts?.data || []);
  const sols = rows.filter(x => (x?.chainId || '').toLowerCase() === 'solana');

  const set = new Set();
  for (const r of sols) {
    const t = r.tokenAddress || r.address || r.token;
    if (!t) continue;
    if (String(t).toLowerCase().endsWith('pump')) continue; // old-token mode only
    set.add(t);
  }
  return [...set];
}

/* ---------- pairs fallback (tokens -> token-pairs -> search) ---------- */
async function fetchPairsForId(id){
  if (String(id).toLowerCase().endsWith('pump')) return [];

  // Try #1: latest/dex/tokens
  try {
    const toks = await getJson(`${DS_BASE}/latest/dex/tokens/solana/${id}`);
    const arr = Array.isArray(toks?.pairs) ? toks.pairs : [];
    if (arr.length) return arr;
  } catch {}

  // Try #2: token-pairs/v1 (older but forgiving)
  try {
    const arr = await getJson(`${DS_BASE}/token-pairs/v1/solana/${id}`);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}

  // Try #3: latest/dex/search
  try {
    const s = await getJson(`${DS_BASE}/latest/dex/search?q=${encodeURIComponent(id)}`);
    const arr = Array.isArray(s?.pairs) ? s.pairs : [];
    return arr.filter(p => (p?.chainId || '').toLowerCase() === 'solana');
  } catch {}

  return [];
}

/* ---------- choose best pair (supported DEX only; SOL/USDC both ok) ---------- */
function pickBestPair(pairs){
  const supported = pairs.filter(p => isSupportedDex(p));
  if (supported.length === 0) return { best: null, reason: 'unsupported-dex' };

  const scored = supported.map(p => {
    const ch5   = +p?.priceChange?.m5 || 0;
    const vol5  = +p?.volume?.m5 || 0;
    const buys  = +p?.txns?.m5?.buys || 0;
    const sells = +p?.txns?.m5?.sells || 0;
    const liq   = +p?.liquidity?.usd || 0;
    const ratio = buys / Math.max(1, sells);
    let score   = 0;
    if (ch5  >= MIN_5M_CHANGE)     score += 1;
    if (vol5 >= MIN_VOL_5M_USD)    score += 1;
    if (buys >= MIN_5M_BUYS)       score += 1;
    if (ratio>= MIN_BUY_SELL_R)    score += 1;
    if (liq  >= MIN_LIQ_USD && liq <= MAX_LIQ_USD) score += 1;
    return { p: p, score, ch5, vol5, buys, sells, ratio, liq };
  }).sort((a,b)=> b.score - a.score || b.ch5 - a.ch5);

  const top = scored[0];
  if (!top || top.score < 4) return { best: null, reason: 'filters-failed' }; // need ≥4/5 signals
  return { best: top.p, reason: 'ok' };
}

/* ---------- scanner (404-safe, pool-aware, smart attempted) ---------- */
async function scanAndMaybeBuy(){
  rotateDayIfNeeded();
  try {
    if (DAILY_MAX_BUYS > 0 && buysToday >= DAILY_MAX_BUYS) return;

    const now = Date.now();
    if (now - lastBuyAt < BUY_COOLDOWN_MS) return;

    const mints = await fetchBoostedSolanaMints();
    console.log('[SCAN]', 'boostedIds=', mints.length);

    for (const mint of mints) {
      if (attempted.has(mint)) continue;

      try {
        const pairs = await fetchPairsForId(mint);
        if (!pairs.length) {
          console.log('[SKIP]', mint, 'no pairs found');
          attempted.add(mint);                 // no pair: avoid spam
          continue;
        }

        const pick = pickBestPair(pairs);
        if (!pick.best) {
          if (pick.reason === 'unsupported-dex') {
            console.log('[SKIP]', mint, 'unsupported DEX');
            attempted.add(mint);               // unsupported: avoid spam
          } else {
            console.log('[SKIP]', mint, 'filters not met (will recheck later)');
            // filters-failed: DO NOT add to attempted => we can re-evaluate next cycles
          }
          continue;
        }

        const best     = pick.best;
        const baseMint = best?.baseToken?.address;
        const pairAddr = best?.pairAddress;
        const ch5      = +best?.priceChange?.m5 || 0;
        const vol5     = +best?.volume?.m5 || 0;
        const buys     = +best?.txns?.m5?.buys || 0;
        const sells    = +best?.txns?.m5?.sells || 0;
        const liq      = +best?.liquidity?.usd || 0;
        const pool     = choosePoolForPair(best);
        const entryPrice = +best?.priceNative || 0; // in SOL

        console.log('[CANDIDATE]', baseMint, 'pair=', pairAddr, 'dexId=', best?.dexId,
          `5m%=${ch5} vol5=$${vol5} buys=${buys}/${sells} liq=$${liq} pool=${pool}`);

        // BUY
        await tradeLightning({ action: 'buy', mint: baseMint, amount: BUY_SOL, pool });
        lastBuyAt = Date.now();
        buysToday += 1;
        attempted.add(mint);                   // buy attempted: mark once

        // estimate token qty from entry price (no RPC)
        const spendSol   = BUY_SOL + PRIORITY_FEE;
        const qtyEst     = entryPrice > 0 ? (spendSol * (1 - FEE_PCT)) / entryPrice : 0;

        positions.set(baseMint, {
          pairAddress: pairAddr,
          entryCostSol: spendSol,
          tokenQty: qtyEst, peakExitVal: 0, tpSeen: false, openedAt: Date.now(),
          pool
        });
        console.log('[EST QTY]', baseMint, 'qty≈', qtyEst.toFixed(6), 'entryPrice(SOL)=', entryPrice);

        monitorPosition(baseMint).catch(()=>{});
        if (DAILY_MAX_BUYS > 0 && buysToday >= DAILY_MAX_BUYS) break;

      } catch (e) {
        console.error('[CANDIDATE ERR]', mint, e?.message || e);
        attempted.add(mint); // mark to avoid spamming a bad id this session
        continue;
      }
    }
  } catch (e) {
    console.error('[SCAN TOP ERR]', e?.message || e);
  }
}

/* ---------- DexScreener pair fetch ---------- */
async function fetchPair(chainPair){
  const j = await getJson(`${DS_BASE}/latest/dex/pairs/solana/${chainPair}`);
  const p = j?.pairs?.[0];
  return p || null;
}

/* ---------- monitor positions (price-based, no RPC) ---------- */
async function monitorPosition(mint){
  const pos = positions.get(mint);
  if (!pos) return;

  const { pairAddress } = pos;
  if (!pairAddress) { console.warn('[MONITOR] no pair for', mint); return; }

  while (positions.has(mint)) {
    try {
      const pair = await fetchPair(pairAddress);
      const priceNative = +pair?.priceNative || 0; // in SOL
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
    const pos = positions.get(mint);
    const pool = pos?.pool || 'auto';
    await tradeLightning({ action: 'sell', mint, amount: '100%', denomSol: false, pool });
  } catch (e) {
    console.error('[SELL FAIL]', mint, e?.message || e);
    return;
  }
  positions.delete(mint);
}

/* ---------- main loop ---------- */
console.log('[START] Old-token momentum mode (DexScreener boosts)');
setInterval(scanAndMaybeBuy, BOOST_POLL_MS);
scanAndMaybeBuy(); // kick immediately

// keep alive
setInterval(()=>{}, 1e9);
