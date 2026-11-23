import { barDelta, totalVolume } from './market-data.js';
import { footprintOf, sessionProfile, applyTickToBar, emptyBar, tickVolume as footprintTickVolume, DEFAULT_FOOTPRINT_OPTIONS } from './footprint-engine.js';
import { zoneLabelRu, zoneStateRu } from './zone-labels.js';
import { chartScale } from './chart-scale.js';
const $ = s => document.querySelector(s);
const chart=$('#priceChart'), grid=$('#footprintGrid'), zoneList=$('#zoneList'), toast=$('#toast'), chartEmpty=$('#chartEmpty');
let bars=[], zones=[], selected=-1, selectedZone=null, showZones=true, showNumbers=true, mode='bidask', live=false, replayMode=false, toastTimer;
let levels=[], analysisMeta=null, hasAutoScrolled=false;
let horizontalZoom=1, verticalZoom=1, footprintZoomX=1, footprintZoomY=1, chartDrag=null, suppressChartClickUntil=0;
const chartViewport=chart.parentElement;
// The user's footprint options (published by settings-client at module init and on every save).
// The live path recomputes the forming bar with them, so a changed setting shows at once.
const footprintOptions=()=>window.gold3poSettings?.footprint&&Object.keys(window.gold3poSettings.footprint).length?window.gold3poSettings.footprint:DEFAULT_FOOTPRINT_OPTIONS;
const fmt=(v,d=2)=>Number(v).toLocaleString('ru-RU',{minimumFractionDigits:d,maximumFractionDigits:d});
const timeLabel=(value,options={},method='toLocaleString')=>{const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date[method]('en-GB',options);};
const zonesWord=n=>{const tens=n%100,ones=n%10;if(ones===1&&tens!==11)return n+' зона';if(ones>=2&&ones<=4&&(tens<12||tens>14))return n+' зоны';return n+' зон';};
const barsWord=n=>{const tens=n%100,ones=n%10;if(ones===1&&tens!==11)return n+' СВЕЧА';if(ones>=2&&ones<=4&&(tens<12||tens>14))return n+' СВЕЧИ';return n+' СВЕЧЕЙ';};
const zoneStateText=state=>zoneStateRu(state);
const zoneLabelText=label=>zoneLabelRu(label);
function notify(s){toast.textContent=s;toast.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('visible'),2100);}
function currentLevels(){if(!live)return levels;const start=Math.max(0,Math.min(Math.max(0,bars.length-24),selected-12)),subset=bars.slice(start,start+24),set=new Set();for(const b of subset)for(const l of b.levels||[])set.add(Number(l.price));return [...set].sort((a,b)=>b-a).slice(0,32);}
function setEmptyState(empty){if(chartEmpty)chartEmpty.hidden=!empty;}
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
function updateChartZoomControls(){
 const horizontal=$('#chartZoomReset'),vertical=$('#chartPriceZoomReset');
 if(horizontal)horizontal.textContent=Math.round(horizontalZoom*100)+'%';
 if(vertical)vertical.textContent='Y';
}
function changeHorizontalZoom(next,anchorClientX=null){
 const oldWidth=Math.max(1,chart.getBoundingClientRect().width);
 const rect=chartViewport.getBoundingClientRect();
 const localX=anchorClientX===null?chartViewport.clientWidth/2:clamp(anchorClientX-rect.left,0,chartViewport.clientWidth);
 const contentX=chartViewport.scrollLeft+localX;
 horizontalZoom=clamp(next,0.25,8);
 renderChart();
 const newWidth=Math.max(1,chart.getBoundingClientRect().width);
 chartViewport.scrollLeft=Math.max(0,contentX*newWidth/oldWidth-localX);
 updateChartZoomControls();
}
function changeVerticalZoom(next){verticalZoom=clamp(next,0.25,8);renderChart();updateChartZoomControls();}
function updateFootprintZoomControls(){
 const x=$('#footZoomXReset'),y=$('#footZoomYReset');
 if(x)x.textContent='X '+Math.round(footprintZoomX*100)+'%';
 if(y)y.textContent='Y '+Math.round(footprintZoomY*100)+'%';
}
function changeFootprintZoom(axis,next){
 if(axis==='x')footprintZoomX=clamp(next,0.35,3.5);
 else footprintZoomY=clamp(next,0.55,3);
 renderFootprint();updateFootprintZoomControls();
}
function bindChartNavigation(){
 if(!chartViewport||chartViewport.dataset.navigationBound==='1')return;
 chartViewport.dataset.navigationBound='1';
 chartViewport.addEventListener('wheel',event=>{
  if(!bars.length)return;
  event.preventDefault();
  const factor=event.deltaY<0?1.12:1/1.12;
  if(event.shiftKey)changeVerticalZoom(verticalZoom*factor);
  else changeHorizontalZoom(horizontalZoom*factor,event.clientX);
 },{passive:false});
 chartViewport.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;
  chartDrag={startX:event.clientX,startScrollLeft:chartViewport.scrollLeft,moved:false};
  chartViewport.classList.add('chart-panning');
 });
 window.addEventListener('pointermove',event=>{
  if(!chartDrag)return;
  const delta=event.clientX-chartDrag.startX;
  if(Math.abs(delta)>3)chartDrag.moved=true;
  if(chartDrag.moved){chartViewport.scrollLeft=chartDrag.startScrollLeft-delta;chartViewport.classList.add('is-dragging');}
 });
 const endDrag=()=>{
  if(chartDrag?.moved)suppressChartClickUntil=performance.now()+250;
  chartDrag=null;chartViewport.classList.remove('chart-panning','is-dragging');
 };
 window.addEventListener('pointerup',endDrag);
 window.addEventListener('pointercancel',endDrag);
}
bindChartNavigation();
$('#chartZoomOut')?.addEventListener('click',()=>changeHorizontalZoom(horizontalZoom/1.2));
$('#chartZoomIn')?.addEventListener('click',()=>changeHorizontalZoom(horizontalZoom*1.2));
$('#chartZoomReset')?.addEventListener('click',()=>{horizontalZoom=1;renderChart();chartViewport.scrollLeft=chartViewport.scrollWidth;updateChartZoomControls();});
$('#chartPriceZoomOut')?.addEventListener('click',()=>changeVerticalZoom(verticalZoom/1.2));
$('#chartPriceZoomIn')?.addEventListener('click',()=>changeVerticalZoom(verticalZoom*1.2));
$('#chartPriceZoomReset')?.addEventListener('click',()=>changeVerticalZoom(1));
window.addEventListener('resize',()=>renderChart());
function renderChart(){
 if(!bars.length){chart.innerHTML='';chart.setAttribute('viewBox','0 0 1000 390');chart.style.width='100%';setEmptyState(true);return;}
 setEmptyState(false);
 const left=64;
 // The chart fills the panel at any window width (up to 4K) and compresses history into it: a bar
 // may shrink to 3px on a laptop panel and 2px on a 4K one before the series becomes a scroll strip.
 const wrapWidth=Math.max(320,Math.round((chart.parentElement?.clientWidth||960)-16));
 const scale=chartScale({panelWidth:wrapWidth,bars:bars.length,left,zoom:horizontalZoom});
 const width=scale.width, step=scale.step, svgWidth=scale.svgWidth;
 const allPrices=bars.flatMap(b=>[b.h,b.l]); if(!allPrices.length){setEmptyState(true);return;}
 const rawMin=Math.min(...allPrices),rawMax=Math.max(...allPrices),rawRange=Math.max(0.01,rawMax-rawMin+2),center=(rawMin+rawMax)/2;
 const visibleRange=rawRange/verticalZoom,min=center-visibleRange/2,max=center+visibleRange/2;
 const x=i=>left+step*(i+.5),y=p=>34+(max-p)/(max-min)*315,cw=Math.max(1,Math.min(26,step*.62));
 const rawStep=(max-min)/8,mag=10**Math.floor(Math.log10(rawStep)),gridStep=[1,2,2.5,5,10].map(m=>m*mag).find(v=>v>=rawStep);
 let html=''; for(let p=Math.ceil(min/gridStep)*gridStep;p<=max;p+=gridStep)html+=`<line x1="${left}" y1="${y(p)}" x2="${left+width}" y2="${y(p)}" class="grid-line"/><text x="${left+width+12}" y="${y(p)+4}" class="axis-label">${fmt(p,gridStep<1?2:gridStep<10?1:0)}</text>`;
 if(showZones)for(const z of zones){const top=y(z.high),h=Math.max(4,y(z.low)-y(z.high)),c=z.side==='buy'?'zone-buy':'zone-sell';html+=`<rect x="${left}" y="${top}" width="${width}" height="${h}" class="${c} ${selectedZone===z.id?'selected-zone':''}" opacity="${.08+z.strength*.2}"/><line x1="${left}" y1="${top}" x2="${left+width}" y2="${top}" class="${c}-edge"/>`;}
 const multiDay=(Date.parse(bars.at(-1).time)-Date.parse(bars[0].time))>86400000;
 const labelStep=Math.max(1,Math.ceil(bars.length/Math.max(2,Math.floor(width/92))));
 const axisLabel=b=>!multiDay?timeLabel(b.time,{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})
   :width>=700?timeLabel(b.time,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'UTC'})
   :timeLabel(b.time,{day:'2-digit',month:'2-digit',timeZone:'UTC'});
 bars.forEach((b,i)=>{const cx=x(i),up=b.c>=b.o,top=Math.min(y(b.o),y(b.c)),h=Math.max(1.5,Math.abs(y(b.o)-y(b.c)));html+=`<g class="candle ${i===selected?'selected-candle':''}" data-index="${i}" tabindex="0" role="button" aria-label="Выбрать свечу ${i+1}"><line x1="${cx}" y1="${y(b.h)}" x2="${cx}" y2="${y(b.l)}" class="wick ${up?'wick-up':'wick-down'}"/><rect x="${cx-cw/2}" y="${top}" width="${cw}" height="${h}" rx="1" class="${up?'candle-up':'candle-down'}"/><rect x="${cx-step/2}" y="30" width="${step}" height="322" class="hit-area"/></g>`;
 if(i%labelStep===0)html+=`<text x="${cx}" y="378" text-anchor="middle" class="time-label">${axisLabel(b)}</text>`;});
 const last=bars.at(-1),py=y(last.c);html+=`<line x1="${left}" y1="${py}" x2="${left+width}" y2="${py}" class="last-price-line"/><rect x="${left+width-2}" y="${py-11}" width="70" height="22" rx="5" class="last-price-tag"/><text x="${left+width+33}" y="${py+4}" text-anchor="middle" class="last-price-text">${fmt(last.c)}</text>`;
 chart.setAttribute('viewBox',`0 0 ${svgWidth} 390`);chart.style.width=svgWidth+'px';chart.innerHTML=html;
 updateChartZoomControls();
 chart.querySelectorAll('.candle').forEach(n=>{const f=()=>{if(performance.now()<suppressChartClickUntil)return;select(Number(n.dataset.index));};n.addEventListener('click',f);n.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();f();}});});if(live&&!hasAutoScrolled){chartViewport.scrollLeft=chartViewport.scrollWidth;hasAutoScrolled=true;}
}
function renderZones(){
 const buyCount=zones.filter(z=>z.side==='buy').length,sellCount=zones.filter(z=>z.side==='sell').length;
 $('#zoneCount').textContent=String(zones.length).padStart(2,'0');$('#aboveZones').textContent=zonesWord(buyCount);$('#belowZones').textContent=zonesWord(sellCount);
 if(!zones.length){zoneList.innerHTML='<div class="zone-empty">Зон пока нет. Они появятся, когда загрузится история брокера.</div>';return;}
 zoneList.innerHTML=zones.map(z=>{const src=Array.isArray(z.sources)?z.sources.filter(Boolean):[];const reaction=z.reactions?.touches?`реакция ${z.reactions.respected}/${z.reactions.touches}`:'касаний не было';return `<button class="zone-row ${selectedZone===z.id?'selected':''}" data-zone="${z.id}" title="${src.map(zoneLabelText).join(', ')}"><span class="zone-side-dot ${z.side}"></span><span class="zone-info"><strong>${zoneLabelText(z.label)}</strong><small>${fmt(z.low)} — ${fmt(z.high)}</small><span class="zone-meter"><i class="${z.side}" style="width:${z.strength*100}%"></i></span></span><span class="zone-right"><b>${z.distance||''}</b><small>${zoneStateText(z.state)}</small><small class="zone-reaction">${reaction}${src.length?' · источников '+src.length:''}</small></span></button>`;}).join('');
 const stats=$('#zoneStats');
 if(stats){const touches=zones.reduce((n,z)=>n+(z.reactions?.touches||0),0),kept=zones.reduce((n,z)=>n+(z.reactions?.respected||0),0);stats.textContent=touches?`История: ${kept} удержаний из ${touches} касаний · та же история, что и расчёт`:'Проверять пока нечего: в истории нет касаний этих уровней';}
 zoneList.querySelectorAll('button').forEach(n=>n.addEventListener('click',()=>{selectedZone=selectedZone===n.dataset.zone?null:n.dataset.zone;renderZones();renderChart();}));
}
const near=(a,b,t=1e-6)=>Math.abs(Number(a)-Number(b))<t;
// One row of one bar: real per-price volume only. A bar without a level map shows nothing
// instead of an invented distribution.
function levelOf(b,price){
 if(!Array.isArray(b?.levels))return{bid:0,ask:0,unknown:0,total:0};
 const v=b.levels.find(l=>near(l.price,price));
 return v?{bid:v.bid||0,ask:v.ask||0,unknown:v.unknown||0,total:(v.bid||0)+(v.ask||0)+(v.unknown||0)}:{bid:0,ask:0,unknown:0,total:0};
}
function barFootprint(b){
 if(b.poc!==undefined&&b.valueArea!==undefined&&Array.isArray(b.levels))return b;
 if(!Array.isArray(b?.levels))return b;
 return {...b,...footprintOf(b.levels,{...footprintOptions(),h:b.h,l:b.l,c:b.c,priceStep:0.1})};
}
function renderFootprint(){
 if(!bars.length){grid.innerHTML='<div class="detail-caption">Тики брокера ещё не поступили. Подключите MT5, чтобы построить футпринт.</div>';return;}
 // Column count follows the panel width, so the session profile stays on screen instead of
 // hiding behind a horizontal scrollbar.
 const available=Math.max(320,(grid.clientWidth||900)-24),cellWidth=clamp(Math.round(34*footprintZoomX),22,112),maxCols=Math.max(3,Math.min(60,Math.floor((available-68-92)/(cellWidth+3)))),rowHeight=clamp(Math.round(23*footprintZoomY),14,64);
 const windowSize=maxCols,start=Math.max(0,Math.min(Math.max(0,bars.length-windowSize),selected-Math.floor(windowSize/2))),visible=bars.slice(start,start+windowSize),offset=start;
 // Only prices that actually traded are drawn: a row of zeros is not information.
 const traded=new Map();
 for(const b of visible)for(const row of (Array.isArray(b.levels)?b.levels:[])){
  if(!(row.bid||row.ask||row.unknown))continue;
  const key=Number(row.price).toFixed(2);
  if(!traded.has(key))traded.set(key,{price:Number(row.price),total:0,volume:(b.volume||0)});
  traded.get(key).total+=(row.bid||0)+(row.ask||0)+(row.unknown||0);
 }
 const priceRows=[...traded.values()].sort((a,b)=>b.price-a.price).map(item=>item.price);
 if(!priceRows.length){grid.innerHTML='<div class="detail-caption">В выбранном окне нет сделок: футпринт появится с первыми тиками.</div>';return;}
 const feet=visible.map(barFootprint);
 // One scale for the whole panel: a colour means the same thing in every column.
 const scale=Math.max(1,...feet.map(b=>Number(b.maxLevelVolume)||0));
 const profile=sessionProfile(bars,{priceStep:0.1,options:footprintOptions()});
 const currentProfile=profile.current;
 const profileRows=new Map((currentProfile?.levels||[]).map(row=>[row.price.toFixed(2),row]));
 const profileMax=Math.max(1,...(currentProfile?.levels||[]).map(row=>row.total));
 const va=currentProfile?.valueArea||null;
 const cols=visible.length,template=`68px repeat(${cols},${cellWidth}px) 92px`,minWidth=68+cols*(cellWidth+3)+92;
 const head=`<div class="foot-row foot-head" style="grid-template-columns:${template};min-width:${minWidth}px"><div class="price-level">ЦЕНА</div>${visible.map((b,i)=>`<div class="bar-head ${offset+i===selected?'active':''}">#${String(offset+i+1).padStart(3,'0')}</div>`).join('')}<div class="foot-profile-head">ПРОФИЛЬ</div></div>`;
 const rows=priceRows.map(p=>`<div class="foot-row" style="grid-template-columns:${template};min-width:${minWidth}px"><div class="price-level">${fmt(p)}</div>${feet.map((b,i)=>{
  const v=levelOf(b,p),delta=v.ask-v.bid,total=v.total||(v.ask+v.bid+v.unknown);
  const intensity=total>0?Math.min(.85,.07+.68*Math.pow(total/scale,.65)):0;
  const isPoc=b.poc!=null&&near(b.poc,p),inVa=!!b.valueArea&&p<=b.valueArea.high+1e-9&&p>=b.valueArea.low-1e-9;
  const imbalance=b.imbalances?.find(x=>near(x.price,p))?.side||null;
  const absorbed=(b.absorbedLevels||[]).some(x=>near(x.price,p));
  const levelRows=Array.isArray(b.levels)?b.levels:[];
  const unfinished=(levelRows.length&&near(levelRows[0].price,p)&&b.unfinishedHigh)||(levelRows.length&&near(levelRows.at(-1).price,p)&&b.unfinishedLow);
  let content='',cls='';
  if(mode==='bidask'){content=showNumbers&&total?`<span>${v.unknown&&!v.bid&&!v.ask?'·':v.bid}</span><span>${v.unknown&&!v.bid&&!v.ask?'·':v.ask}</span>`:'';cls='bidask';}
  if(mode==='delta'){content=showNumbers?(total?((delta>0?'+':'')+delta):''):'';cls=delta>=0?'delta-positive':'delta-negative';}
  if(mode==='volume'){content=showNumbers&&total?fmt(total,0):'';cls='volume-cell';}
  if(imbalance)cls+=' imbalance-'+imbalance;
  if(isPoc)cls+=' foot-poc';
  if(inVa)cls+=' foot-va';
  if(absorbed)cls+=' foot-absorbed';
  if(unfinished)cls+=' foot-unfinished';
  if(offset+i===bars.length-1)cls+=' foot-forming';
  const marks=[isPoc?'POC':'',inVa?'зона стоимости':'',imbalance?(imbalance==='buy'?'имбаланс покупателей':'имбаланс продавцов'):'',absorbed?'поглощение':'',unfinished?'незакрытый аукцион':''].filter(Boolean).join(' · ');
  return `<button class="foot-cell ${cls} ${offset+i===selected?'active':''}" data-index="${offset+i}" style="--intensity:${intensity.toFixed(3)}" title="Бид ${v.bid}; аск ${v.ask}; без стороны ${v.unknown}${marks?' · '+marks:''}" aria-label="Свеча ${offset+i+1}, цена ${fmt(p)}, бид ${v.bid}, аск ${v.ask}, без стороны ${v.unknown}${marks?', '+marks:''}">${content}${isPoc?'<i class="poc-mark">◆</i>':''}</button>`;}).join('')}${(()=>{
  const row=profileRows.get(Number(p).toFixed(2));
  if(!row||!row.total)return '<div class="foot-profile empty"></div>';
  const isPoc=va&&near(currentProfile.poc,p),inVa=va&&p<=va.high+1e-9&&p>=va.low-1e-9;
  const isVah=va&&near(va.high,p),isVal=va&&near(va.low,p);
  const width=Math.max(1,Math.round(100*row.total/profileMax));
  return `<div class="foot-profile ${inVa?'va':''} ${isPoc?'poc':''}" title="Профиль сессии: ${fmt(row.total,0)} · ${isPoc?'POC':'внутри зоны стоимости'}"><i style="width:${width}%"></i>${isVah?'<b>VAH</b>':isVal?'<b>VAL</b>':isPoc?'<b>POC</b>':''}</div>`;
 })()}</div>`).join('');
 const deltas=`<div class="foot-row foot-deltas" style="grid-template-columns:${template};min-width:${minWidth}px"><div class="price-level">Δ СВЕЧИ</div>${feet.map((b,i)=>{const d=b.unknown>0?null:(b.delta??barDelta(b));return `<div class="foot-delta ${d===null?'':d>=0?'positive':'negative'} ${offset+i===selected?'active':''}">${d===null?'—':((d>0?'+':'')+fmt(d,0))}</div>`;}).join('')}<div class="foot-profile-total">${currentProfile?fmt(currentProfile.volume,0):'—'}</div></div>`;
 const times=`<div class="foot-row foot-times" style="grid-template-columns:${template};min-width:${minWidth}px"><div class="price-level">ВРЕМЯ</div>${visible.map((b,i)=>`<button class="bar-time ${offset+i===selected?'active':''}" data-index="${offset+i}">${timeLabel(b.time,{hour:'2-digit',minute:'2-digit',timeZone:'UTC'},'toLocaleTimeString')}</button>`).join('')}<div class="foot-profile-head">СЕССИЯ</div></div>`;
 grid.innerHTML=`<div class="footprint-table" style="min-width:${minWidth}px;--footprint-row-height:${rowHeight}px">${head}${deltas}${rows}${times}</div>`;
 updateFootprintZoomControls();
 // Keep the latest price in view unless the trader scrolled the panel themselves.
 if(grid.dataset.autoScroll!=='0'){
  const target=grid.querySelector('.foot-cell.foot-forming.foot-poc')||[...grid.querySelectorAll('.foot-cell.foot-forming')].find(node=>node.textContent.trim());
  if(target){const row=target.closest('.foot-row'),box=grid.getBoundingClientRect(),rect=row.getBoundingClientRect();
   if(rect.top<box.top+50||rect.bottom>box.bottom-50)grid.scrollTop+=rect.top-box.top-Math.round((box.height-rect.height)/2);}
 }
 grid.querySelectorAll('[data-index]').forEach(n=>n.addEventListener('click',()=>select(Number(n.dataset.index))));
}
// A wheel or touch scroll means the trader took over the view; stop re-centring the price axis.
for(const type of ['wheel','touchmove','pointerdown'])grid.addEventListener(type,()=>{grid.dataset.autoScroll='0';},{passive:true});
$('#resetView')?.addEventListener('click',()=>{grid.dataset.autoScroll='1';});
function renderInspector(){
 const clear=()=>{$('#selectedBar').textContent='—';$('#selectedDelta').textContent='— Δ';$('#selectedDelta').className='delta-chip';for(const id of ['bidVolume','askVolume','totalVolume','unknownVolume','imbalance','pocPrice','valueAreaRange','absorbedInfo','unfinishedInfo']){const n=$('#'+id);if(n)n.textContent='—';}const v=$('#flowVerdict');if(v){v.className='flow-verdict';v.textContent='Выберите столбец футпринта: POC, зона стоимости и незакрытый аукцион считаются по тикам брокера.';}};
 const raw=bars[selected];if(!raw){clear();return;}
 const b=barFootprint(raw);
 const d=(b.unknown||0)>0?null:(b.delta??barDelta(b)),bid=b.bid||0,ask=b.ask||0;
 $('#selectedBar').textContent=`#${String(selected+1).padStart(3,'0')} · ${timeLabel(b.time,{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit',timeZone:'UTC'})}`;
 $('#selectedDelta').textContent=d===null?'— Δ':`${d>0?'+':''}${fmt(d,0)} Δ`;
 $('#selectedDelta').className=`delta-chip ${d===null?'':d>=0?'positive-bg':'negative-bg'}`;
 $('#bidVolume').textContent=fmt(bid,0);
 $('#askVolume').textContent=fmt(ask,0);
 $('#totalVolume').textContent=fmt(b.volume??totalVolume(b),0);
 $('#unknownVolume').textContent=(b.unknown||0)>0?fmt(b.unknown,0):'—';
 $('#imbalance').textContent=bid&&ask?`${(Math.max(bid,ask)/Math.min(bid,ask)).toFixed(2)}×`:'—';
 $('#pocPrice').textContent=b.poc!=null?fmt(b.poc):'—';
 $('#valueAreaRange').textContent=b.valueArea?`${fmt(b.valueArea.low)} — ${fmt(b.valueArea.high)} · ${Math.round(b.valueArea.share*100)}%`:'—';
 const absorbed=b.absorbedLevels||[];
 $('#absorbedInfo').textContent=absorbed.length?absorbed.map(item=>`${fmt(item.price)} ×${item.multiple}`).join(' · '):'нет';
 const open=[b.unfinishedHigh?'верх':null,b.unfinishedLow?'низ':null].filter(Boolean);
 $('#unfinishedInfo').textContent=open.length?'не закрыт: '+open.join(' и '):'закрыт';
 const divergence=analysisMeta?.divergence;
 const verdict=$('#flowVerdict');
 if(verdict){
  const stacked=(b.stackedImbalances||[]).length;
  const parts=[];
  if(b.poc!=null)parts.push(`POC ${fmt(b.poc)}`);
  if(b.valueArea)parts.push(`зона стоимости ${fmt(b.valueArea.low)}–${fmt(b.valueArea.high)}`);
  parts.push(b.imbalances?.length?`имбалансов ${b.imbalances.length}${stacked?`, из них стеков ${stacked}`:''}`:'имбалансов нет');
  parts.push(absorbed.length?`поглощение на ${absorbed.length===1?'уровне':absorbed.length+' уровнях'}`:'поглощения нет');
  let text=`${parts.join(' · ')}.`;
  if(divergence?.side)text+=divergence.side==='bearish'?' Цена растёт, кумулятивная дельта падает — покупатели не подтверждают движение.':' Цена падает, кумулятивная дельта растёт — продавцы не подтверждают движение.';
  verdict.className=`flow-verdict ${divergence?.side?'is-'+divergence.side:''}`;
  verdict.textContent=text;
 }
}
function select(i){
 if(!Number.isInteger(i)||i<0||i>=bars.length){selected=-1;renderInspector();renderChart();renderFootprint();return;}
 selected=i;renderInspector();renderChart();renderFootprint();
}
$('#zonesToggle').addEventListener('click',e=>{showZones=!showZones;e.currentTarget.setAttribute('aria-pressed',String(showZones));e.currentTarget.classList.toggle('is-off',!showZones);renderChart();notify(showZones?'Зоны ликвидности показаны':'Зоны ликвидности скрыты');});
$('#numbersToggle').addEventListener('click',e=>{showNumbers=!showNumbers;e.currentTarget.setAttribute('aria-pressed',String(showNumbers));renderFootprint();});
$('#footZoomXOut')?.addEventListener('click',()=>changeFootprintZoom('x',footprintZoomX/1.2));
$('#footZoomXIn')?.addEventListener('click',()=>changeFootprintZoom('x',footprintZoomX*1.2));
$('#footZoomXReset')?.addEventListener('click',()=>changeFootprintZoom('x',1));
$('#footZoomYOut')?.addEventListener('click',()=>changeFootprintZoom('y',footprintZoomY/1.2));
$('#footZoomYIn')?.addEventListener('click',()=>changeFootprintZoom('y',footprintZoomY*1.2));
$('#footZoomYReset')?.addEventListener('click',()=>changeFootprintZoom('y',1));
grid.addEventListener('wheel',event=>{
 if(event.ctrlKey){event.preventDefault();changeFootprintZoom('x',footprintZoomX*(event.deltaY<0?1.12:1/1.12));}
 else if(event.shiftKey){event.preventDefault();changeFootprintZoom('y',footprintZoomY*(event.deltaY<0?1.12:1/1.12));}
},{passive:false});
$('#footprintModes').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;$('#footprintModes').querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===b));renderFootprint();}));
$('#resetView').addEventListener('click',()=>{replayMode=false;showZones=true;showNumbers=true;mode='bidask';horizontalZoom=1;verticalZoom=1;footprintZoomX=1;footprintZoomY=1;selectedZone=null;$('#zonesToggle').setAttribute('aria-pressed','true');$('#numbersToggle').setAttribute('aria-pressed','true');$('#zonesToggle').classList.remove('is-off');renderZones();$('#footprintModes').querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b.dataset.mode==='bidask'));select(bars.length-1);chartViewport.scrollLeft=chartViewport.scrollWidth;updateChartZoomControls();notify('Вид сброшен');});
const workspace=$('#workspace'),layoutButton=$('#layoutButton'),panelResizer=$('#chartPanelResizer');
let layoutMode='stacked',splitRatio=0.5,splitPointer=false;
try{layoutMode=localStorage.getItem('gold3po-layout')==='split'?'split':'stacked';splitRatio=clamp(Number(localStorage.getItem('gold3po-split')||0.5),0.32,0.68);}catch{}
function applyWorkspaceLayout(){
 workspace.classList.toggle('trading-layout',layoutMode==='split');
 workspace.style.setProperty('--chart-split',`${Math.round(splitRatio*100)}%`);
 if(layoutButton){const label=layoutButton.querySelector('span');if(label)label.textContent=layoutMode==='split'?'Окна: рядом':'Рабочая область';layoutButton.setAttribute('aria-pressed',String(layoutMode==='split'));}
 requestAnimationFrame(()=>{renderChart();renderFootprint();});
}
layoutButton.addEventListener('click',()=>{
 layoutMode=layoutMode==='split'?'stacked':'split';
 try{localStorage.setItem('gold3po-layout',layoutMode);}catch{}
 applyWorkspaceLayout();notify(layoutMode==='split'?'График и футпринт размещены рядом':'График и футпринт расположены вертикально');
});
panelResizer?.addEventListener('pointerdown',event=>{
 if(layoutMode!=='split'||event.button!==0)return;
 event.preventDefault();splitPointer=true;panelResizer.setPointerCapture?.(event.pointerId);
});
window.addEventListener('pointermove',event=>{
 if(!splitPointer)return;
 const column=workspace.querySelector('.chart-column'),rect=column.getBoundingClientRect();
 if(rect.width<=0)return;
 splitRatio=clamp((event.clientX-rect.left)/rect.width,0.32,0.68);
 workspace.style.setProperty('--chart-split',`${Math.round(splitRatio*100)}%`);
});
const finishSplit=()=>{if(!splitPointer)return;splitPointer=false;try{localStorage.setItem('gold3po-split',String(splitRatio));}catch{};renderChart();renderFootprint();};
window.addEventListener('pointerup',finishSplit);window.addEventListener('pointercancel',finishSplit);
applyWorkspaceLayout();
// A streamed tick updates the forming bar in place: the last footprint column and the last
// candle move between authoritative refetches instead of waiting for the next 1.5 s poll.
let liveFrame=0,liveRenderedAt=0;
function scheduleLiveRender(){
 if(liveFrame)return;
 const wait=Math.max(0,250-(performance.now()-liveRenderedAt));
 liveFrame=setTimeout(()=>{liveFrame=0;liveRenderedAt=performance.now();renderChart();renderFootprint();if(selected===bars.length-1)renderInspector();},wait);
}
function applyLiveTick(event){
 if(replayMode||!bars.length||!event)return;
 const time=Date.parse(event.timestamp),interval=Number(analysisMeta?.intervalMs||window.gold3poIntervalMs?.()||900000);
 if(!Number.isFinite(time)||!(interval>0))return;
 const start=Math.floor(time/interval)*interval;
 const previous=bars.at(-1);
 if(start<previous.timeMs)return; // a late tick for a closed bar: the next refetch is authoritative
 if(start>previous.timeMs){
  const fresh={...emptyBar(start,Number(event.last)),time:new Date(start).toISOString()};
  fresh.levelMap=new Map();
  bars.push(fresh);
  if(selected===bars.length-2)selected=bars.length-1;
 }else if(!bars.at(-1).levelMap&&Array.isArray(bars.at(-1).levels)){
  bars.at(-1).levelMap=new Map(bars.at(-1).levels.map(row=>[Number(row.price).toFixed(8),{...row}]));
 }
 const bar=bars.at(-1);
 const state={levels:bar.levelMap,o:bar.o,h:bar.h,l:bar.l,c:bar.c,volume:bar.volume||0,bid:bar.bid||0,ask:bar.ask||0,unknown:bar.unknown||0,tickCount:bar.tickCount||0};
 applyTickToBar(state,{last:Number(event.last),volume:footprintTickVolume(event),aggressorSide:event.aggressorSide,flags:event.flags},0.1);
 const foot=footprintOf(state.levels,{...footprintOptions(),h:state.h,l:state.l,c:state.c});
 bar.levelMap=state.levels;
 Object.assign(bar,{o:state.o,h:state.h,l:state.l,c:state.c,volume:state.volume,bid:state.bid,ask:state.ask,unknown:state.unknown,tickCount:state.tickCount,
  levels:foot.levels,delta:foot.delta,deltaRatio:foot.deltaRatio,poc:foot.poc,valueArea:foot.valueArea,imbalances:foot.imbalances,
  stackedImbalances:foot.stackedImbalances,absorbedLevels:foot.absorbedLevels,unfinishedHigh:foot.unfinishedHigh,unfinishedLow:foot.unfinishedLow,maxLevelVolume:foot.maxLevelVolume});
 bar.cumulativeDelta=(bars[bars.length-2]?.cumulativeDelta||0)+bar.delta;
 scheduleLiveRender();
}
window.addEventListener('market-tick',e=>applyLiveTick(e.detail));
// Footprint settings changed: re-render with the new options. Bars served before the change carry
// the old marks, so drop their cached footprint fields and recompute them from the level maps.
window.addEventListener('gold3po-settings',()=>{for(const b of bars){if(Array.isArray(b.levels)&&b.poc!==undefined){delete b.poc;delete b.valueArea;delete b.imbalances;delete b.stackedImbalances;delete b.absorbedLevels;delete b.unfinishedHigh;delete b.unfinishedLow;delete b.delta;delete b.deltaRatio;delete b.maxLevelVolume;}}renderFootprint();renderInspector();});
window.addEventListener('market-analysis',e=>{if(replayMode)return;const a=e.detail;if(!a?.bars?.length)return;const previousTime=bars[selected]?.time,wasAtLatest=selected===bars.length-1;bars=a.bars;live=true;analysisMeta=a;const tf=Number(a.timeframeMinutes||Number(a.intervalMs)/60000);document.querySelectorAll('.timeframe-label').forEach(node=>{if(Number.isFinite(tf)&&tf>0){const caption=tf>=60?(tf%60===0?tf/60+'ч':tf+'м'):tf+'м';node.textContent=caption+(node.classList.contains('footprint-timeframe')?' · ЕДИНЫЙ ТФ':' · ТИКИ БРОКЕРА');}});zones=a.zones||[];selected=wasAtLatest||selected<0?bars.length-1:Math.max(0,bars.findIndex(b=>b.time===previousTime));levels=currentLevels();const feedLive=a.feed?.status==='online';const status=$('#chartStatus');if(status){status.textContent=(feedLive?'ОНЛАЙН · ':'ИСТОРИЯ · ')+barsWord(bars.length);status.className=feedLive?'ok':'warning';}const signalSummary=$('#signalSummary');if(signalSummary){const sweeps=bars.reduce((n,b)=>n+(b.sweeps?.length||0),0),stacked=bars.reduce((n,b)=>n+(b.stackedImbalances?.length||0),0),absorption=bars.filter(b=>b.absorption).length,exhaustion=bars.filter(b=>b.exhaustion).length,unfinished=bars.filter(b=>b.unfinishedHigh||b.unfinishedLow).length,absorbed=bars.reduce((n,b)=>n+((b.absorbedLevels||[]).length?1:0),0);const naked=a.profile?.naked?.length||0,div=a.divergence?.side;signalSummary.textContent='СНЯТИЯ '+sweeps+' · СТЕКИ '+stacked+' · ПОГЛОЩЕНИЕ УРОВНЕЙ '+absorbed+' · НЕЗАКРЫТЫЕ АУКЦИОНЫ '+unfinished+(naked?' · ГОЛЫХ POC '+naked:'')+(div?(div==='bearish'?' · ДИВЕРГЕНЦИЯ: МЕДВЕЖЬЯ':' · ДИВЕРГЕНЦИЯ: БЫЧЬЯ'):'');}const tag=$('#dataMode');if(tag)tag.textContent=feedLive?'ROBOFOREX MT5 · ОНЛАЙН':'ROBOFOREX MT5 · ИСТОРИЯ';const range=$('#barCount');if(range)range.textContent=barsWord(bars.length);const windowNode=$('#sessionWindow');if(windowNode){const hh=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');};windowNode.textContent=hh(bars[0].time)+' — '+hh(bars.at(-1).time);}renderZones();select(selected);});
window.addEventListener('market-replay',e=>{
 const a=e.detail;if(!a?.bars?.length)return;
 replayMode=true;bars=a.bars;live=true;analysisMeta=a;zones=a.zones||[];selected=0;levels=currentLevels();hasAutoScrolled=false;
 const status=$('#chartStatus');if(status){status.textContent='ПОВТОР · '+barsWord(bars.length);status.className='ok';}
 const tag=$('#dataMode');if(tag)tag.textContent='ИСТОРИЧЕСКИЙ ПОВТОР';
 const count=$('#barCount');if(count)count.textContent=barsWord(bars.length);
 const summary=$('#signalSummary');if(summary)summary.textContent='ПОВТОР · '+(a.eventCount||0)+' ТИКОВ БРОКЕРА';
 renderZones();select(0);
});
window.addEventListener('market-replay-step',e=>{if(replayMode)select(Number(e.detail?.index));});
window.addEventListener('exit-replay',()=>{replayMode=false;});
const initialStatus=$('#chartStatus');if(initialStatus&&!live){initialStatus.textContent='ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5';initialStatus.className='warning';}
let resizeTimer=null;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=window.setTimeout(()=>{renderChart();renderFootprint();},150);});
if(typeof ResizeObserver!=='undefined'){
 const workspaceResizeObserver=new ResizeObserver(entries=>{
  for(const entry of entries){
   if(entry.target===chartViewport)renderChart();
   if(entry.target===grid)renderFootprint();
  }
 });
 workspaceResizeObserver.observe(chartViewport);
 workspaceResizeObserver.observe(grid);
}
renderZones();renderInspector();renderChart();renderFootprint();
