import { marketSymbol, marketFeedId, hasMt5Bridge } from './mt5-client.js';
import { priceDigits, priceText, createQuoteGate } from './quote-display.js';
import { bucketStart } from './rate-store.js';

// The page's link to the local market service.
//  - Live ticks arrive on the SSE stream and move the forming candle in the browser at once.
//  - The authoritative window (candles, footprint, zones) is reloaded when a candle closes, when history
//    lands, on a timeframe change, on the refresh button, and every ANALYSIS_EVERY_MS as a safety net —
//    never once per tick: a multi-megabyte reload per tick is what made the interface lag.
//  - A silent stream is reopened, and while it is silent the newest quote is read directly.
const api=document.querySelector('#apiStatus'),mt5=document.querySelector('#mt5Status'),comex=document.querySelector('#comexStatus');
const labels={mt5,comex};
const ANALYSIS_EVERY_MS=10000,STREAM_SILENCE_MS=15000,QUOTE_POLL_MS=1000,QUOTE_POLL_SILENCE_MS=2500,STALE_MS=45000;
const pill=document.querySelector('.demo-pill'),link=document.querySelector('.connection');
const quotes=createQuoteGate();
let source=null,reconnectTimer=null,lastFrameAt=Date.now();
let analysisTimer=null,analysisInFlight=null,analysisQueued=false,lastAnalysisAt=0,requestSerial=0;
let clearedWithoutFeed=false,quoteDigits=2,lastSseTickAt=0,lastTickSeq=0,quotePolling=false,feedOnline=false;
let displayedFeedId=null,feedOverride=null,feedMismatch=0,lastBucket=null,forceFresh=false,alignMs=0,comexSummary=null;
const feedStates={online:'ОНЛАЙН',stale:'УСТАРЕЛ',offline:'ОФФЛАЙН',waiting:'ОЖИДАНИЕ'};
const feedText=status=>feedStates[String(status||'').toLowerCase()]||String(status||'ОЖИДАНИЕ').toUpperCase();
const intervalMs=()=>Number(window.gold3poIntervalMs?.())||900000;
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
// Two MT5 accounts can quote XAUUSD at different levels: say which one is on screen.
function renderFeedConflict(conflict){
 const node=document.querySelector('#feedConflict');
 if(!node)return;
 if(!conflict){node.hidden=true;node.textContent='';return;}
 const entries=conflict.feeds.map(item=>priceText(item.price,quoteDigits)+' — счёт '+String(item.feedId||'legacy').slice(0,6)+(item.active?' (на графике)':'')).join(' · ');
 node.textContent='⚠ По XAUUSD подключено несколько счетов с разной ценой: '+entries+'. В терминале может быть другой счёт.';
 node.hidden=false;
}
// The one feed the page shows: analysis, the stream filter and the quote strip all use it.
function activeFeedId(){return feedOverride||displayedFeedId||marketFeedId()||null;}
function updateReferencePrice(price,timestamp){
 const value=Number(price);
 if(!Number.isFinite(value)||value<=0)return;
 paintQuote(quotes.accept({bid:value,ask:value,last:value,timestamp}),{strip:false});
}
function clearFeedDisplay(){
 quotes.reset();displayedFeedId=null;feedOverride=null;lastBucket=null;
 const price=document.querySelector('#referencePrice');if(price){price.textContent='—';price.removeAttribute('title');delete price.dataset.archive;}
 const range=document.querySelector('#sessionRange');if(range)range.textContent='Ожидание истории';
 const mode=document.querySelector('#dataMode');if(mode)mode.textContent='ОЖИДАНИЕ ROBOFOREX MT5';
 const count=document.querySelector('#barCount');if(count)count.textContent='ОЖИДАНИЕ ИСТОРИИ';
 const status=document.querySelector('#chartStatus');if(status){status.textContent='ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5';status.className='warning';}
 window.dispatchEvent(new CustomEvent('market-feed-clear'));
}
function archiveStamp(iso){const d=new Date(iso);return Number.isNaN(d.getTime())?'':d.toLocaleString([],{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function markArchive(at){
 const price=document.querySelector('#referencePrice');if(!price)return;
 if(at){price.dataset.archive='1';price.title='АРХИВ · последняя сохранённая котировка '+new Date(at).toLocaleString()+' — живых данных от MT5 нет';}
 else delete price.dataset.archive;
}
// One request at a time; a request made while one is running is queued once. An answer for a timeframe
// or feed the page has since left is dropped instead of being drawn.
function refreshAnalysis(){
 if(analysisInFlight){analysisQueued=true;return analysisInFlight;}
 analysisInFlight=loadAnalysis().finally(()=>{analysisInFlight=null;if(analysisQueued){analysisQueued=false;scheduleAnalysis(0);}});
 return analysisInFlight;
}
async function loadAnalysis(){
 const feedId=marketFeedId();
 if(!feedId&&hasMt5Bridge()){if(!clearedWithoutFeed){clearFeedDisplay();clearedWithoutFeed=true;}lastAnalysisAt=Date.now();return;}
 clearedWithoutFeed=false;
 const requestedFeedId=feedOverride||feedId||null;
 const wantedInterval=intervalMs();
 const serial=++requestSerial;
 try{
  const params=new URLSearchParams({symbol:marketSymbol(),priceStep:'0.1',limit:'800',intervalMs:String(wantedInterval)});
  if(requestedFeedId)params.set('feedId',requestedFeedId);
  const levelsFrom=Number(window.gold3poLevelsFrom?.());
  if(Number.isFinite(levelsFrom)&&levelsFrom>0)params.set('levelsFrom',String(levelsFrom));
  if(forceFresh){params.set('fresh','1');forceFresh=false;}
  const response=await fetch('/v1/market/analysis?'+params,{cache:'no-store'});
  if(!response.ok)throw new Error('HTTP '+response.status);
  const data=await response.json();
  if(serial!==requestSerial||wantedInterval!==intervalMs())return;
  if(requestedFeedId&&(data.feedId||null)!==requestedFeedId){
   // The account was switched in MT5: after two answers naming another feed, follow the server.
   feedMismatch+=1;
   if(feedMismatch<2)return;
   feedMismatch=0;feedOverride=data.feedId||null;scheduleAnalysis(0);return;
  } else feedMismatch=0;
  // A pinned account that went quiet while another one streams: follow the live one.
  if(requestedFeedId&&data.liveFeedId&&data.liveFeedId!==requestedFeedId){
   const prices=data.feedPrices||[];
   const pinned=prices.find(item=>item.feedId===requestedFeedId),live=prices.find(item=>item.feedId===data.liveFeedId);
   if(pinned&&live&&pinned.ageMs>20000&&live.ageMs<10000){feedOverride=data.liveFeedId;scheduleAnalysis(0);return;}
  }
  displayedFeedId=data.feedId||null;
  alignMs=Number(data.clockOffsetMs)||0;
  if(data.bars?.length){
   lastBucket=data.bars.at(-1).timeMs;
   window.dispatchEvent(new CustomEvent('market-analysis',{detail:data}));
   quoteDigits=priceDigits(data.footprintStep);
   feedOnline=data.feed?.status==='online';
   const archiveAt=feedOnline?null:(data.archive?.lastTickAt||null);
   const mode=document.querySelector('#dataMode');if(mode)mode.textContent=(feedOnline?'ROBOFOREX MT5 · ОНЛАЙН':'ROBOFOREX MT5 · АРХИВ'+(archiveAt?' до '+archiveStamp(archiveAt):''))+(data.feedId?' · '+String(data.feedId).slice(0,6):'');
   renderFeedConflict(data.priceConflict);
   if(Number.isFinite(data.lastQuote?.sequence))lastTickSeq=Math.max(lastTickSeq,data.lastQuote.sequence);
   if(data.lastQuote)updateReferencePrice(data.lastQuote.last,data.lastQuote.timestamp);
   else updateReferencePrice(data.bars.at(-1).c,data.bars.at(-1).time);
   markArchive(archiveAt);
   let lo=Infinity,hi=-Infinity;for(const b of data.bars){if(b.l<lo)lo=b.l;if(b.h>hi)hi=b.h;}
   const range=document.querySelector('#sessionRange');if(range)range.textContent=priceText(lo,quoteDigits)+' — '+priceText(hi,quoteDigits);
  }
  lastAnalysisAt=Date.now();
 }catch{ /* the chart stays on the last verified window; the next timer or tick retries */ }
}
function scheduleAnalysis(delay=400){
 if(analysisTimer)return;
 analysisTimer=window.setTimeout(()=>{analysisTimer=null;refreshAnalysis();},delay);
}
async function refreshHealth(){
 try{
  const response=await fetch('/health',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);
  const health=await response.json();paint(api,health.ingestConfigured?'API ОНЛАЙН':'НЕТ ТОКЕНА',health.ingestConfigured?'online':'warning');
  const shown=activeFeedId();
  const mt5Feed=health.feeds.find(item=>item.source==='mt5'&&item.symbol===marketSymbol()&&(item.feedId||null)===(shown||null));
  if(!mt5Feed)paint(mt5,'ОЖИДАНИЕ','warning');else paint(mt5,feedText(mt5Feed.status)+' · '+ageLabel(mt5Feed.ageMs),mt5Feed.status);
  // A licensed real-time COMEX feed pushed into the service wins over the delayed public quote.
  const comexFeed=health.feeds.find(item=>item.source==='comex');
  if(comexFeed)paint(comex,feedText(comexFeed.status)+' · ЛЕНТА · '+ageLabel(comexFeed.ageMs),comexFeed.status);
  else paintComexStatus();
 }catch{paint(api,'API НЕДОСТУПЕН','error');paint(mt5,'НЕДОСТУПНО','error');paint(comex,'НЕДОСТУПНО','error');}
}
// A tick in a newer candle than the window's last one: the previous candle just closed, so the window
// (footprint marks, zones) is reloaded once.
function noteTickBucket(timestamp){
 const at=Date.parse(timestamp);if(!Number.isFinite(at))return;
 const bucket=bucketStart(at,intervalMs(),alignMs);
 if(lastBucket!==null&&bucket>lastBucket){lastBucket=bucket;scheduleAnalysis(600);}
}
function connectStream(){
 if(!('EventSource'in window)){paint(api,'SSE НЕ ПОДДЕРЖИВАЕТСЯ','error');return;}
 lastFrameAt=Date.now();
 source=new EventSource('/v1/stream');
 source.onopen=()=>{lastFrameAt=Date.now();refreshHealth();scheduleAnalysis(0);};
 source.addEventListener('ping',()=>{lastFrameAt=Date.now();});
 source.addEventListener('ready',()=>{lastFrameAt=Date.now();});
 source.onerror=()=>{paint(api,'ПЕРЕПОДКЛЮЧЕНИЕ','warning');reconnect();};
 source.addEventListener('history',event=>{
  lastFrameAt=Date.now();
  try{const notice=JSON.parse(event.data);if((notice.feedId||null)===(activeFeedId()||null)||!activeFeedId())scheduleAnalysis(1500);}catch{}
 });
 // The broker's candles were (re)loaded: draw them.
 source.addEventListener('candles',event=>{
  lastFrameAt=Date.now();
  try{const notice=JSON.parse(event.data);if(notice.symbol===marketSymbol()&&((notice.feedId||null)===(activeFeedId()||null)||!activeFeedId()))scheduleAnalysis(800);}catch{}
 });
 source.addEventListener('spec',event=>{
  lastFrameAt=Date.now();
  try{const notice=JSON.parse(event.data);if(notice.symbol===marketSymbol()&&((notice.feedId||null)===(activeFeedId()||null)||!activeFeedId()))scheduleAnalysis(0);}catch{}
 });
 source.addEventListener('market',event=>{try{
  lastFrameAt=Date.now();
  const message=JSON.parse(event.data),target=labels[message.source];
  if(message.source==='mt5'&&message.symbol===marketSymbol()&&(message.feedId||null)===(activeFeedId()||null)){
   if(message.historical){scheduleAnalysis(1500);return;}
   lastSseTickAt=Date.now();
   if(Number.isFinite(message.sequence))lastTickSeq=Math.max(lastTickSeq,message.sequence);
   paint(mt5,'ОНЛАЙН · '+ageLabel(Date.now()-Date.parse(message.receivedAt)),'online');
   window.dispatchEvent(new CustomEvent('market-tick',{detail:message}));
   noteTickBucket(message.timestamp);
  }else if(message.source==='mt5'&&message.symbol===marketSymbol()&&!message.historical&&!activeFeedId()){
   scheduleAnalysis(0);
  }else if(message.source==='comex'&&target&&!message.historical){
   paint(target,'ОНЛАЙН · '+ageLabel(Date.now()-Date.parse(message.receivedAt)),'online');
  }
 }catch{/* malformed frames are ignored; /health stays authoritative */}});
}
function reconnect(){
 if(reconnectTimer)return;
 reconnectTimer=window.setTimeout(()=>{reconnectTimer=null;try{source?.close();}catch{}connectStream();},3000);
}
function streamWatch(){
 if(Date.now()-lastFrameAt<STREAM_SILENCE_MS)return;
 paint(api,'ПЕРЕПОДКЛЮЧЕНИЕ','warning');
 try{source?.close();}catch{}
 connectStream();
 scheduleAnalysis(0);
}
function watchdog(){
 if(document.hidden)return;
 const age=Date.now()-lastAnalysisAt;
 if(age>=ANALYSIS_EVERY_MS)scheduleAnalysis(0);
 if(lastAnalysisAt&&age>STALE_MS)paint(mt5,'АНАЛИТИКА НЕ ОБНОВЛЯЕТСЯ · '+Math.round(age/1000)+' с','warning');
}
// Safety net under the stream: while it is silent the newest quote is read directly, so the price
// never freezes while MT5 is quoting. Ticks already seen on the stream are not repeated.
async function pollQuote(){
 if(quotePolling||document.hidden||Date.now()-lastSseTickAt<QUOTE_POLL_SILENCE_MS)return;
 quotePolling=true;
 try{
  const params=new URLSearchParams({symbol:marketSymbol()});
  const wanted=activeFeedId();if(wanted)params.set('feedId',wanted);
  const response=await fetch('/v1/quote?'+params,{cache:'no-store'});
  if(!response.ok)return;
  const quote=await response.json();
  if(quote.ageMs>20000||!(quote.sequence>lastTickSeq))return;
  lastTickSeq=quote.sequence;
  if(!wanted&&quote.feedId&&quote.feedId!==displayedFeedId){scheduleAnalysis(0);return;}
  window.dispatchEvent(new CustomEvent('market-tick',{detail:{...quote,polled:true}}));
  noteTickBucket(quote.timestamp);
 }catch{ /* the stream or the next poll recovers */ }
 finally{quotePolling=false;}
}
window.addEventListener('mt5-symbol-change',()=>{quotes.reset();lastBucket=null;scheduleAnalysis(0);refreshHealth();});
window.addEventListener('mt5-feed-change',()=>{quotes.reset();feedOverride=null;clearedWithoutFeed=false;lastBucket=null;scheduleAnalysis(0);refreshHealth();});
window.addEventListener('gold3po-settings',e=>{if(e.detail?.zonesChanged)scheduleAnalysis(0);});
// A timeframe click is answered at once in the new timeframe; the settings save follows on its own.
window.addEventListener('gold3po-timeframe',()=>{lastBucket=null;requestSerial+=1;scheduleAnalysis(0);});
// The refresh buttons: the MT5 bridge polls now (or reopens if it was lost), the service rebuilds the
// window from its buffer, and the stream is reopened.
window.gold3poRefresh=async()=>{
 quotes.reset();lastTickSeq=0;feedMismatch=0;lastBucket=null;forceFresh=true;
 try{source?.close();}catch{}
 connectStream();
 try{await window.goldMt5?.refresh?.();}catch{}
 refreshHealth();refreshComex();
 requestSerial+=1;
 if(analysisInFlight){analysisQueued=true;await analysisInFlight;}
 return refreshAnalysis();
};
// The strip follows every tick of the feed on screen; the gate keeps a late frame from rewinding it.
window.addEventListener('market-tick',event=>{
 const tick=event.detail;
 const shownFeedId=activeFeedId();
 if(!tick||tick.source!=='mt5'||tick.symbol!==marketSymbol()||(tick.feedId||null)!==(shownFeedId||null))return;
 paintQuote(quotes.accept(tick));
});
// COMEX GC: the delayed public quote of the front month, its basis to spot and the session levels.
function paintComexStatus(){
 const s=comexSummary;
 if(!s)return paint(comex,'ОЖИДАНИЕ','warning');
 if(s.status==='disabled')return paint(comex,'ВЫКЛЮЧЕНО','warning');
 if(s.status==='loading')return paint(comex,'ЗАГРУЗКА','warning');
 if(s.status==='error')return paint(comex,'НЕТ ДАННЫХ · '+(s.error||'ошибка'),'error');
 const delay=Number.isFinite(s.delayMs)?Math.round(s.delayMs/60000):null;
 paint(comex,(s.status==='closed'?'РЫНОК ЗАКРЫТ':'ЗАДЕРЖКА '+(delay??'—')+' МИН')+(s.error?' · ОШИБКА ОБНОВЛЕНИЯ':''),s.status==='delayed'&&!s.error?'online':'warning');
}
async function refreshComex(){
 if(document.hidden&&comexSummary)return;
 try{
  const response=await fetch('/v1/comex?symbol='+encodeURIComponent(marketSymbol()),{cache:'no-store'});
  if(!response.ok)return;
  comexSummary=await response.json();
  const price=document.querySelector('#comexPrice'),delay=document.querySelector('#comexDelay'),basis=document.querySelector('#comexBasis');
  const s=comexSummary;
  if(price)price.textContent=Number.isFinite(s.price)?priceText(s.price,1)+(Number.isFinite(s.change)?'  '+(s.change>=0?'+':'')+s.change.toFixed(1):''):'—';
  if(delay)delay.textContent=s.status==='delayed'?'· −'+Math.round((s.delayMs||0)/60000)+' МИН':s.status==='closed'?'· ЗАКРЫТ':'';
  if(basis)basis.textContent=Number.isFinite(s.basis)?'базис '+(s.basis>=0?'+':'')+s.basis.toFixed(2)+' · объём '+(s.sessionVolume||0).toLocaleString('ru-RU'):(s.status==='error'?'нет связи с источником':'базис к споту —');
  paintComexStatus();
  window.dispatchEvent(new CustomEvent('gold3po-comex',{detail:s}));
 }catch{ /* the next round retries */ }
}
window.gold3poComex=()=>comexSummary;
// The footprint asks for the window again when it is scrolled onto candles whose ladders were not sent.
window.gold3poRequestAnalysis=()=>scheduleAnalysis(300);
refreshHealth();refreshAnalysis();connectStream();refreshComex();
window.setInterval(refreshComex,20000);
window.addEventListener('license-activated',refreshComex);
window.setInterval(refreshHealth,5000);
window.setInterval(watchdog,2000);
window.setInterval(streamWatch,5000);
window.setInterval(pollQuote,QUOTE_POLL_MS);
