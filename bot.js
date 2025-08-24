require('dotenv').config();
const WebSocket = require('ws');
const bs58 = require('bs58');
const { fetch, Agent } = require('undici');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBKEY = process.env.PUBLIC_KEY;
const SECRET = process.env.WALLET_PRIVATE_KEY;
const BUY_SOL = parseFloat(process.env.BUY_SOL || '0.005');
const SLIPPAGE = parseInt(process.env.SLIPPAGE || '15', 10);
const PRIORITY_FEE = parseFloat(process.env.PRIORITY_FEE || '0.0000');
const TAKE_PROFIT = parseFloat(process.env.TAKE_PROFIT_PCT || '50') / 100;

if (!PUBKEY || !SECRET) { console.error('Secrets not set!'); process.exit(1); }

const signer = Keypair.fromSecretKey(bs58.decode(SECRET));
const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
const httpAgent = new Agent({ keepAliveTimeout: 60e3, keepAliveMaxTimeout: 60e3, keepAlive: true });

const WS_URL = 'wss://pumpportal.fun/api/data';
const pos = new Map(); // mint -> { entryCostSol, tokenQty }

function estSolPerToken(m){ const vs=+m?.vSolInBondingCurve, vt=+m?.vTokensInBondingCurve; return (vs>0&&vt>0)?(vs/vt):null; }

async function tradeOnce(body){
  const r = await fetch('https://pumpportal.fun/api/trade-local', {
    method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(body), dispatcher: httpAgent
  });
  let bytes;
  try{ const ab = await r.arrayBuffer(); const u8 = new Uint8Array(ab); if (u8.length>0) bytes=u8; }catch(_){}
  if (!bytes){
    const j = await r.json().catch(()=>null);
    const b64 = j?.transaction || j?.tx || j?.data;
    if (!b64) throw new Error('trade-local parse fail');
    bytes = Buffer.from(b64,'base64');
  }
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([signer]);
  return await conn.sendTransaction(tx,{skipPreflight:true,maxRetries:3});
}

async function instantBuy(mint){
  try{
    const body={publicKey:PUBKEY,action:'buy',mint,amount:BUY_SOL,denominatedInSol:'true',slippage:SLIPPAGE,priorityFee:PRIORITY_FEE,pool:'auto'};
    await tradeOnce(body);
    pos.set(mint,{entryCostSol:BUY_SOL+PRIORITY_FEE,tokenQty:0});
  }catch(e){}
}
async function sellAll(mint){
  try{
    const body={publicKey:PUBKEY,action:'sell',mint,amount:'100%',denominatedInSol:'false',slippage:SLIPPAGE,priorityFee:PRIORITY_FEE,pool:'auto'};
    await tradeOnce(body); pos.delete(mint);
  }catch(e){}
}

function openWS(){
  const ws=new WebSocket(WS_URL,{perMessageDeflate:false});
  ws.on('open',()=>{ws.send(JSON.stringify({method:'subscribeNewToken'}));ws.send(JSON.stringify({method:'subscribeAccountTrade',keys:[PUBKEY]}));});
  ws.on('message',(buf)=>{
    let m; try{m=JSON.parse(buf);}catch{return;}
    if(m?.txType==='create'&&m?.mint){instantBuy(m.mint);return;}
    if(m?.traderPublicKey===PUBKEY&&m?.mint){
      const p=pos.get(m.mint);
      if(p){
        if(m.txType==='buy'){const got=Number(m.tokenAmount||m.newTokenBalance||0);if(got>0&&p.tokenQty===0)p.tokenQty=got;}
        if(m.txType==='sell'){pos.delete(m.mint);}
      } return;
    }
    if(m?.mint&&pos.has(m.mint)){
      const p=pos.get(m.mint); if(!p?.tokenQty)return;
      const spt=estSolPerToken(m); if(!spt)return;
      const estExit=spt*p.tokenQty; const target=p.entryCostSol*(1+TAKE_PROFIT);
      if(estExit>=target) sellAll(m.mint);
    }
  });
  ws.on('close',()=>setTimeout(openWS,1000));
  ws.on('error',()=>{});
}
openWS();
