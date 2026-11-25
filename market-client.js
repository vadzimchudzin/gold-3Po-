import { marketSymbol, marketFeedId, hasMt5Bridge } from './mt5-client.js';
import { priceDigits, priceText, createQuoteGate } from './quote-display.js';
const api=document.querySelector('#apiStatus'),mt5=document.querySelector('#mt5Status'),comex=document.querySelector('#comexStatus');
const labels={mt5,comex};let source;let analysisTimer=null;let lastAnalysisAt=0;let reconnectTimer=null;
const STALE_MS=45000,STREAM_SILENCE_MS=15000;
// Any frame from the stream, ping included. A stream that stays silent is a dead socket (sleep, proxy,
// a restarted service): it is reopened instead of waiting for an error that never comes.
let lastFrameAt=Date.now();
const pill=document.querySelector('.demo-pill'),link=document.querySelector('.connection');
let clearedWithoutFeed=false;
// One gate and one formatter for every quote on the page: a tick that arrives late cannot move the
// strip back, and every field prints the same price with the same decimals.
const quotes=createQuoteGate();
// The feed currently drawn on the chart: the bridge's own feed when it reports one, otherwise the
// live feed the server resolved for us.
let displayedFeedId=null;
// Set when the account the bridge names went quiet and another feed is streaming: the chart then
// follows the live feed instead of a remembered one. Cleared when the bridge switches account.
let feedOverride=null;
// Consecutive answers that name a different feed than the one asked for: a switched MT5 account,
// not a glitch. Two in a row and the page follows the server instead of freezing on the old feed.
let feedMismatch=0;
let quoteDigits=2;
const feedStates={online:'ОНЛАЙН',stale:'УСТАРЕЛ',offline:'ОФФЛАЙН',waiting:'ОЖИДАНИЕ'};
const feedText=status=>feedStates[String(status||'').toLowerCase()]||String(status||'ОЖИДАНИЕ').toUpperCase();
function topStatus(label,state){
 if(pill)pill.lastChild.textContent=' ROBOFOREX MT5 · '+label;
 if(link){link.lastChild.textContent=state==='online'?' ЖИВЫЕ ДАННЫЕ':state==='error'?' НЕТ СВЯЗИ':' ОЖИДАНИЕ ДАННЫХ';link.classList.toggle('is-live',state==='online');}
}
function paint(node,label,state){if(node===mt5)topStatus(label,state);if(!node)return;node.textContent=label;node.className=state==='online'?'ok':state==='error'?'error':'warning';}
function ageLabel(ms){if(!Number.isFinite(ms))return '—';if(ms<1000)return 'СЕЙЧАС';if(ms<60000)return Math.floor(ms/1000)+' с назад';return Math.floor(ms/60000)+' мин назад';}
function paintQuote(quote,{strip=true}={}){
 if(!quote)return;
 const price=document.querySelector('#referencePrice');
 if(price){price.textContent=priceText(quote.last,quoteDigits);price.title=quote.time?'Последняя котировка MT5 · '+new Date(quote.time).toLocaleString():'Котировка MT5';}
 if(!strip)return;
 const bidNode=document.querySelector('#bidPrice'),askNode=document.querySelector('#askPrice'),spreadNode=document.querySelector('#spreadPrice');
 if(bidNode)bidNode.textContent=priceText(quote.bid,quoteDigits);
 if(askNode)askNode.textContent=priceText(quote.ask,quoteDigits);
 if(spreadNode)spreadNode.textContent=priceText(quote.spread,quoteDigits);
}
// Two MT5 accounts can quote XAUUSD at different levels. Say which one is on screen instead of
// leaving the trader to guess why the app and the terminal disagree.
function renderFeedConflict(conflict,feedId){
 const node=document.querySelector('#feedConflict');
 if(!node)return;
 if(!conflict){node.hidden=true;node.textContent='';return;}
 const entries=conflict.feeds.map(item=>{
  const label=String(item.feedId||'legacy').slice(0,6);
  return priceText(item.price,quoteDigits)+' — счёт '+label+(item.active?' (на графике)':'');
 }).join(' · ');
 node.textContent='⚠ По XAUUSD подключено несколько счетов с разной ценой: '+entries+'. В терминале может быть другой счёт.';
 node.hidden=false;
}
// The one feed the page is showing: the bridge's account when it is streaming, otherwise the live
// feed the server resolved. Analysis, the stream filter and the quote strip all use it, so a tick
// can never be judged against a different account than the chart is drawn from.
function activeFeedId(){return feedOverride||displayedFeedId||marketFeedId()||null;}
function updateReferencePrice(price,timestamp){
 const value=Number(price);
 if(!Number.isFinite(value)||value<=0)return;
 paintQuote(quotes.accept({bid:value,ask:value,last:value,timestamp}),{strip:false});
}
function clearFeedDisplay(){
 quotes.reset();
 displayedFeedId=null;
 feedOverride=null;
 const price=document.querySelector('#referencePrice');if(price){price.textContent='—';price.removeAttribute('title');delete price.dataset.archive;}
 const range=document.querySelector('#sessionRange');if(range)range.textContent='Ожидание истории';
 const mode=document.querySelector('#dataMode');if(mode)mode.textContent='ОЖИДАНИЕ ROBOFOREX MT5';
 const count=document.querySelector('#barCount');if(count)count.textContent='ОЖИДАНИЕ ИСТОРИИ';
 const status=document.querySelector('#chartStatus');if(status){status.textContent='ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5';status.className='warning';}
 window.dispatchEvent(new CustomEvent('market-feed-clear'));
}
// An archive is not a price. When the account has no live feed the strip says where the numbers end
// instead of presenting the last stored tick as the current quote.
function archiveStamp(iso){const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleString([],{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function markArchive(at){
 const price=document.querySelector('#referencePrice');if(!price)return;
 if(at){price.dataset.archive='1';price.title='АРХИВ · последняя сохранённая котировка '+new Date(at).toLocaleString()+' — живых данных от MT5 нет';}
 else delete price.dataset.archive;
}
async function refreshAnalysis(){
 const feedId=marketFeedId();
 if(!feedId&&hasMt5Bridge()){if(!clearedWithoutFeed){clearFeedDisplay();clearedWithoutFeed=true;}lastAnalysisAt=Date.now();return;}
 clearedWithoutFeed=false;
 // Never fall back to the "legacy" bucket: it is data with no account attached, and it can be a
 // different market than the terminal. Without a known feed the server resolves the live one.
 const requestedFeedId=feedOverride||feedId||null;
 try{
  const params=new URLSearchParams({symbol:marketSymbol(),priceStep:'0.1',limit:'1200'});
  if(requestedFeedId)params.set('feedId',requestedFeedId);
  const response=await fetch('/v1/market/analysis?'+params,{cache:'no-store'});
  if(!response.ok)throw new Error('HTTP '+response.status);
  const data=await response.json();
  if(requestedFeedId&&(data.feedId||null)!==requestedFeedId){
   // The account was switched in MT5 and the server now resolves a different feed. Discarding these
   // answers forever left the chart frozen on an untradeable price; after two, follow the server.
   feedMismatch+=1;
   if(feedMismatch<2)return;
   feedMismatch=0;feedOverride=data.feedId||null;lastAnalysisAt=0;scheduleAnalysis(0);return;
  } else feedMismatch=0;
  // A pinned account that stopped streaming while another feed is live is the "app says 4100, the
  // terminal says 3600" case: follow the live feed and re-ask straight away.
  if(requestedFeedId&&data.liveFeedId&&(data.liveFeedId||null)!==(requestedFeedId||null)){
   const prices=data.feedPrices||[];
   const pinned=prices.find(item=>item.feedId===requestedFeedId);
   const live=prices.find(item=>item.feedId===(data.liveFeedId||null));
   if(pinned&&live&&pinned.ageMs>20000&&live.ageMs<10000){
    feedOverride=data.liveFeedId;lastAnalysisAt=0;scheduleAnalysis(0);return;
   }
  }
  displayedFeedId=data.feedId||null;
  if(data.bars?.length){
   window.dispatchEvent(new CustomEvent('market-analysis',{detail:data}));
   // The broker's tick size decides the decimals every quote on the page prints with.
   quoteDigits=priceDigits(data.footprintStep);
   const online=data.feed?.status==='online';
   const archiveAt=online?null:(data.archive?.lastTickAt||null);
   const mode=document.querySelector('#dataMode');if(mode)mode.textContent=(online?'ROBOFOREX MT5 · ОНЛАЙН':'ROBOFOREX MT5 · АРХИВ'+(archiveAt?' до '+archiveStamp(archiveAt):''))+(data.feedId?' · '+String(data.feedId).slice(0,6):'');
   renderFeedConflict(data.priceConflict,data.feedId);
   if(data.lastQuote)updateReferencePrice(data.lastQuote.last,data.lastQuote.timestamp);
   else updateReferencePrice(data.bars.at(-1).c,data.bars.at(-1).time);
   // Same number, honest label: without a live feed the value is an archive close, not a quote.
   markArchive(archiveAt);
   const range=document.querySelector('#sessionRange');if(range){const lo=Math.min(...data.bars.map(b=>b.l)),hi=Math.max(...data.bars.map(b=>b.h));range.textContent=priceText(lo,quoteDigits)+' — '+priceText(hi,quoteDigits);}
   const count=document.querySelector('#barCount');if(count)count.textContent=data.bars.length+' СВЕЧЕЙ';
  }
  lastAnalysisAt=Date.now();
 }catch{ /* The chart remains on the last verified feed; health and SSE keep retrying. */ }
}
function scheduleAnalysis(){if(analysisTimer)return;analysisTimer=window.setTimeout(()=>{analysisTimer=null;refreshAnalysis();},500);}
async function refreshHealth(){
 try{
  const response=await fetch('/health',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);
  const health=await response.json();paint(api,health.ingestConfigured?'API ОНЛАЙН':'НЕТ ТОКЕНА',health.ingestConfigured?'online':'warning');
  const currentFeed=marketFeedId();
  const mt5Feed=health.feeds.find(item=>item.source==='mt5'&&item.symbol===marketSymbol()&&item.feedId===currentFeed);
  if(!mt5Feed)paint(mt5,'ОЖИДАНИЕ','warning');else paint(mt5,feedText(mt5Feed.status)+' · '+ageLabel(mt5Feed.ageMs),mt5Feed.status);
  const comexFeed=health.feeds.find(item=>item.source==='comex');
  if(!comexFeed)paint(comex,'ОЖИДАНИЕ','warning');else paint(comex,feedText(comexFeed.status)+' · '+ageLabel(comexFeed.ageMs),comexFeed.status);
  if(Date.now()-lastAnalysisAt>10000)scheduleAnalysis();
 }catch{paint(api,'API НЕДОСТУПЕН','error');paint(mt5,'НЕДОСТУПНО','error');paint(comex,'НЕДОСТУПНО','error');}
}
function connectStream(){
 if(!('EventSource'in window)){paint(api,'SSE НЕ ПОДДЕРЖИВАЕТСЯ','error');return;}
 lastFrameAt=Date.now();source=new EventSource('/v1/stream');source.onopen=()=>{lastFrameAt=Date.now();refreshHealth();scheduleAnalysis();};source.addEventListener('ping',()=>{lastFrameAt=Date.now();});source.addEventListener('ready',()=>{lastFrameAt=Date.now();});source.onerror=()=>{paint(api,'ПЕРЕПОДКЛЮЧЕНИЕ','warning');reconnect();};
 source.addEventListener('market',event=>{try{
   lastFrameAt=Date.now();
   const message=JSON.parse(event.data),target=labels[message.source];
   if(message.source==='mt5'&&message.symbol===marketSymbol()&&(message.feedId||null)===(activeFeedId()||null)){
    if(!message.historical)paint(mt5,'ОНЛАЙН · '+ageLabel(Date.now()-Date.parse(message.receivedAt)),'online');
    if(!message.historical)updateReferencePrice(message.last,message.timestamp);
    scheduleAnalysis();
    if(!message.historical)window.dispatchEvent(new CustomEvent('market-tick',{detail:message}));
   }else if(message.source==='comex'&&target&&!message.historical){
    paint(target,'ОНЛАЙН · '+ageLabel(Date.now()-Date.parse(message.receivedAt)),'online');
   }
  }catch{/* malformed stream frames are ignored; /health remains authoritative */}});
}
function reconnect(){
 if(reconnectTimer)return;
 reconnectTimer=window.setTimeout(()=>{reconnectTimer=null;try{source?.close();}catch{}connectStream();},5000);
}
function streamWatch(){
 if(Date.now()-lastFrameAt<STREAM_SILENCE_MS){return;}
 paint(api,'ПЕРЕПОДКЛЮЧЕНИЕ','warning');
 try{source?.close();}catch{}
 lastFrameAt=Date.now();
 connectStream();
 lastAnalysisAt=0;scheduleAnalysis(0);
}
function watchdog(){
 const age=Date.now()-lastAnalysisAt;
 if(!lastAnalysisAt){scheduleAnalysis();return;}
 if(age>STALE_MS){
  paint(mt5,'АНАЛИТИКА НЕ ОБНОВЛЯЕТСЯ · '+Math.round(age/1000)+' с','warning');
  lastAnalysisAt=0;scheduleAnalysis();
  if(!source||source.readyState===EventSource.CLOSED)reconnect();
 }
}
window.addEventListener('mt5-symbol-change',()=>{lastAnalysisAt=0;quotes.reset();refreshAnalysis();refreshHealth();});
window.addEventListener('mt5-feed-change',()=>{lastAnalysisAt=0;quotes.reset();feedOverride=null;clearedWithoutFeed=false;refreshAnalysis();refreshHealth();});
window.addEventListener('gold3po-settings',e=>{if(e.detail?.zonesChanged){lastAnalysisAt=0;refreshAnalysis();}});
refreshHealth();refreshAnalysis();connectStream();window.setInterval(refreshHealth,5000);window.setInterval(watchdog,10000);window.setInterval(streamWatch,5000);

// Keep the quote strip in sync with the active account's live MT5 quote stream.
// The same gate orders the strip, so a replayed or overlapping frame never rewinds bid/ask.
window.addEventListener('market-tick',event=>{
 const tick=event.detail;
 const shownFeedId=activeFeedId();
 if(!tick||tick.source!=='mt5'||tick.symbol!==marketSymbol()||(tick.feedId||null)!==(shownFeedId||null))return;
 paintQuote(quotes.accept(tick));
});
