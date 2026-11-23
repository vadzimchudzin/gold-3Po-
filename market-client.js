import { marketSymbol } from './mt5-client.js';
const api=document.querySelector('#apiStatus'),mt5=document.querySelector('#mt5Status'),comex=document.querySelector('#comexStatus');
const labels={mt5,comex};let source;let analysisTimer=null;let lastAnalysisAt=0;let reconnectTimer=null;
const STALE_MS=45000;
const pill=document.querySelector('.demo-pill'),link=document.querySelector('.connection');
const feedStates={online:'ОНЛАЙН',stale:'УСТАРЕЛ',offline:'ОФФЛАЙН',waiting:'ОЖИДАНИЕ'};
const feedText=status=>feedStates[String(status||'').toLowerCase()]||String(status||'ОЖИДАНИЕ').toUpperCase();
function topStatus(label,state){
 if(pill)pill.lastChild.textContent=' ROBOFOREX MT5 · '+label;
 if(link){link.lastChild.textContent=state==='online'?' ЖИВЫЕ ДАННЫЕ':state==='error'?' НЕТ СВЯЗИ':' ОЖИДАНИЕ ДАННЫХ';link.classList.toggle('is-live',state==='online');}
}
function paint(node,label,state){if(node===mt5)topStatus(label,state);if(!node)return;node.textContent=label;node.className=state==='online'?'ok':state==='error'?'error':'warning';}
function ageLabel(ms){if(!Number.isFinite(ms))return '—';if(ms<1000)return 'СЕЙЧАС';if(ms<60000)return Math.floor(ms/1000)+' с назад';return Math.floor(ms/60000)+' мин назад';}
async function refreshAnalysis(){
 try{
  const response=await fetch('/v1/market/analysis?symbol='+encodeURIComponent(marketSymbol())+'&priceStep=0.1',{cache:'no-store'});
  if(!response.ok)throw new Error('HTTP '+response.status);
  const data=await response.json();
  if(data.bars?.length){
   window.dispatchEvent(new CustomEvent('market-analysis',{detail:data}));
   const mode=document.querySelector('#dataMode');if(mode)mode.textContent=data.feed?.status==='online'?'ROBOFOREX MT5 · ОНЛАЙН':'ROBOFOREX MT5 · ИСТОРИЯ';
   const price=document.querySelector('#referencePrice');if(price)price.textContent=Number(data.bars.at(-1).c).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});const range=document.querySelector('#sessionRange');if(range){const lo=Math.min(...data.bars.map(b=>b.l)),hi=Math.max(...data.bars.map(b=>b.h));range.textContent=lo.toFixed(2)+' — '+hi.toFixed(2);}
   const count=document.querySelector('#barCount');if(count)count.textContent=data.bars.length+' СВЕЧЕЙ';
   lastAnalysisAt=Date.now();
  }
 }catch{ /* Отсутствие фида брокера не должно ломать рабочую область. */ }
}
function scheduleAnalysis(){if(analysisTimer)return;analysisTimer=window.setTimeout(()=>{analysisTimer=null;refreshAnalysis();},500);}
async function refreshHealth(){
 try{
  const response=await fetch('/health',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);
  const health=await response.json();paint(api,health.ingestConfigured?'API ОНЛАЙН':'НЕТ ТОКЕНА',health.ingestConfigured?'online':'warning');
  for(const name of ['mt5','comex']){const feed=health.feeds.find(item=>item.source===name&&(name==='comex'||!item.symbol||item.symbol===marketSymbol()));if(!feed)paint(labels[name],'ОЖИДАНИЕ','warning');else paint(labels[name],feedText(feed.status)+' · '+ageLabel(feed.ageMs),feed.status);}
  if(Date.now()-lastAnalysisAt>10000)scheduleAnalysis();
 }catch{paint(api,'API НЕДОСТУПЕН','error');paint(mt5,'НЕДОСТУПНО','error');paint(comex,'НЕДОСТУПНО','error');}
}
function connectStream(){
 if(!('EventSource'in window)){paint(api,'SSE НЕ ПОДДЕРЖИВАЕТСЯ','error');return;}
 source=new EventSource('/v1/stream');source.onopen=()=>{refreshHealth();scheduleAnalysis();};source.onerror=()=>{paint(api,'ПЕРЕПОДКЛЮЧЕНИЕ','warning');reconnect();};
 source.addEventListener('market',event=>{try{const message=JSON.parse(event.data);const target=labels[message.source];if(target&&!message.historical)paint(target,'ОНЛАЙН · '+ageLabel(Date.now()-Date.parse(message.receivedAt)),'online');if(message.source==='mt5'&&message.symbol===marketSymbol()){scheduleAnalysis();
   // The forming bar is updated from the tick itself, so the footprint moves between refetches.
   if(!message.historical)window.dispatchEvent(new CustomEvent('market-tick',{detail:message}));}}catch{/* повреждённый кадр игнорируется: опрос /health остаётся источником истины */}});
}
// EventSource reconnects on its own, but a closed stream or a stalled API never recovers without this.
function reconnect(){
 if(reconnectTimer)return;
 reconnectTimer=window.setTimeout(()=>{reconnectTimer=null;try{source?.close();}catch{}connectStream();},5000);
}
function watchdog(){
 const age=Date.now()-lastAnalysisAt;
 if(!lastAnalysisAt){scheduleAnalysis();return;}
 if(age>STALE_MS){
  // Data exists but stopped arriving: say so instead of showing a frozen chart as if it were live.
  paint(mt5,'ДАННЫЕ УСТАРЕЛИ · '+Math.round(age/1000)+' с','warning');
  lastAnalysisAt=0;
  scheduleAnalysis();
  if(!source||source.readyState===EventSource.CLOSED)reconnect();
 }
}
window.addEventListener('mt5-symbol-change',()=>{lastAnalysisAt=0;refreshAnalysis();refreshHealth();});
window.addEventListener('gold3po-settings',e=>{if(e.detail?.zonesChanged){lastAnalysisAt=0;refreshAnalysis();}});
refreshHealth();refreshAnalysis();connectStream();window.setInterval(refreshHealth,5000);window.setInterval(watchdog,10000);
