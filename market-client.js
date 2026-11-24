import { marketSymbol, marketFeedId, hasMt5Bridge } from './mt5-client.js';
const api=document.querySelector('#apiStatus'),mt5=document.querySelector('#mt5Status'),comex=document.querySelector('#comexStatus');
const labels={mt5,comex};let source;let analysisTimer=null;let lastAnalysisAt=0;let reconnectTimer=null;
const STALE_MS=45000;
const pill=document.querySelector('.demo-pill'),link=document.querySelector('.connection');
let displayedQuoteTime=0,clearedWithoutFeed=false;
const feedStates={online:'ОНЛАЙН',stale:'УСТАРЕЛ',offline:'ОФФЛАЙН',waiting:'ОЖИДАНИЕ'};
const feedText=status=>feedStates[String(status||'').toLowerCase()]||String(status||'ОЖИДАНИЕ').toUpperCase();
function topStatus(label,state){
 if(pill)pill.lastChild.textContent=' ROBOFOREX MT5 · '+label;
 if(link){link.lastChild.textContent=state==='online'?' ЖИВЫЕ ДАННЫЕ':state==='error'?' НЕТ СВЯЗИ':' ОЖИДАНИЕ ДАННЫХ';link.classList.toggle('is-live',state==='online');}
}
function paint(node,label,state){if(node===mt5)topStatus(label,state);if(!node)return;node.textContent=label;node.className=state==='online'?'ok':state==='error'?'error':'warning';}
function ageLabel(ms){if(!Number.isFinite(ms))return '—';if(ms<1000)return 'СЕЙЧАС';if(ms<60000)return Math.floor(ms/1000)+' с назад';return Math.floor(ms/60000)+' мин назад';}
function updateReferencePrice(price,timestamp){
 const value=Number(price),stamp=Date.parse(timestamp||'');
 if(!Number.isFinite(value)||value<=0)return;
 if(Number.isFinite(stamp)&&stamp>0&&stamp<displayedQuoteTime)return;
 if(Number.isFinite(stamp)&&stamp>0)displayedQuoteTime=stamp;
 const node=document.querySelector('#referencePrice');
 if(node){node.textContent=value.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});node.title=timestamp?'Последняя котировка MT5 · '+new Date(timestamp).toLocaleString():'Котировка MT5';}
}
function clearFeedDisplay(){
 displayedQuoteTime=0;
 const price=document.querySelector('#referencePrice');if(price){price.textContent='—';price.removeAttribute('title');}
 const range=document.querySelector('#sessionRange');if(range)range.textContent='Ожидание истории';
 const mode=document.querySelector('#dataMode');if(mode)mode.textContent='ОЖИДАНИЕ ROBOFOREX MT5';
 const count=document.querySelector('#barCount');if(count)count.textContent='ОЖИДАНИЕ ИСТОРИИ';
 const status=document.querySelector('#chartStatus');if(status){status.textContent='ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5';status.className='warning';}
 window.dispatchEvent(new CustomEvent('market-feed-clear'));
}
async function refreshAnalysis(){
 const feedId=marketFeedId();
 if(!feedId&&hasMt5Bridge()){if(!clearedWithoutFeed){clearFeedDisplay();clearedWithoutFeed=true;}lastAnalysisAt=Date.now();return;}
 clearedWithoutFeed=false;
 const requestedFeedId=feedId||'legacy';
 try{
  const params=new URLSearchParams({symbol:marketSymbol(),priceStep:'0.1',feedId:requestedFeedId});
  const response=await fetch('/v1/market/analysis?'+params,{cache:'no-store'});
  if(!response.ok)throw new Error('HTTP '+response.status);
  const data=await response.json();
  if((data.feedId||null)!==(feedId||null))return;
  if(data.bars?.length){
   window.dispatchEvent(new CustomEvent('market-analysis',{detail:data}));
   const mode=document.querySelector('#dataMode');if(mode)mode.textContent=data.feed?.status==='online'?'ROBOFOREX MT5 · ОНЛАЙН':'ROBOFOREX MT5 · ИСТОРИЯ';
   if(data.lastQuote)updateReferencePrice(data.lastQuote.last,data.lastQuote.timestamp);
   else updateReferencePrice(data.bars.at(-1).c,data.bars.at(-1).time);
   const range=document.querySelector('#sessionRange');if(range){const lo=Math.min(...data.bars.map(b=>b.l)),hi=Math.max(...data.bars.map(b=>b.h));range.textContent=lo.toFixed(2)+' — '+hi.toFixed(2);}
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
 source=new EventSource('/v1/stream');source.onopen=()=>{refreshHealth();scheduleAnalysis();};source.onerror=()=>{paint(api,'ПЕРЕПОДКЛЮЧЕНИЕ','warning');reconnect();};
 source.addEventListener('market',event=>{try{
   const message=JSON.parse(event.data),target=labels[message.source];
   if(message.source==='mt5'&&message.symbol===marketSymbol()&&(message.feedId||null)===(marketFeedId()||null)){
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
function watchdog(){
 const age=Date.now()-lastAnalysisAt;
 if(!lastAnalysisAt){scheduleAnalysis();return;}
 if(age>STALE_MS){
  paint(mt5,'АНАЛИТИКА НЕ ОБНОВЛЯЕТСЯ · '+Math.round(age/1000)+' с','warning');
  lastAnalysisAt=0;scheduleAnalysis();
  if(!source||source.readyState===EventSource.CLOSED)reconnect();
 }
}
window.addEventListener('mt5-symbol-change',()=>{lastAnalysisAt=0;displayedQuoteTime=0;refreshAnalysis();refreshHealth();});
window.addEventListener('mt5-feed-change',()=>{lastAnalysisAt=0;displayedQuoteTime=0;clearedWithoutFeed=false;refreshAnalysis();refreshHealth();});
window.addEventListener('gold3po-settings',e=>{if(e.detail?.zonesChanged){lastAnalysisAt=0;refreshAnalysis();}});
refreshHealth();refreshAnalysis();connectStream();window.setInterval(refreshHealth,5000);window.setInterval(watchdog,10000);

// Keep the quote strip in sync with the active account's live MT5 quote stream.
function quoteText(value) {
 const number=Number(value);
 return Number.isFinite(number)
  ? number.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:4})
  : '—';
}
window.addEventListener('market-tick',event=>{
 const tick=event.detail;
 const activeFeedId=marketFeedId();
 if(!activeFeedId||!tick||tick.source!=='mt5'||tick.symbol!==marketSymbol()||tick.feedId!==activeFeedId)return;
 const bid=Number(tick.bid),ask=Number(tick.ask);
 if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<=0||ask<bid)return;
 const bidNode=document.querySelector('#bidPrice');
 const askNode=document.querySelector('#askPrice');
 const spreadNode=document.querySelector('#spreadPrice');
 if(bidNode)bidNode.textContent=quoteText(bid);
 if(askNode)askNode.textContent=quoteText(ask);
 if(spreadNode)spreadNode.textContent=quoteText(ask-bid);
});
