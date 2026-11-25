import { barDelta, totalVolume } from './market-data.js';
import { footprintOf, footprintCell, sessionProfile, applyTickToBar, emptyBar, tickVolume as footprintTickVolume, DEFAULT_FOOTPRINT_OPTIONS, autoTicksPerRow } from './footprint-engine.js';
import { zoneLabelRu, zoneStateRu } from './zone-labels.js';
import { candlePart } from './footprint-candle.js';
import { chartScale, priceRange, wheelIntent, zoomScrollAnchor, CHART_AXIS, CHART_ZOOM } from './chart-scale.js';
import { deltaPaneMarkup } from './delta-pane.js';
const $ = s => document.querySelector(s);
const chart=$('#priceChart'), grid=$('#footprintGrid'), zoneList=$('#zoneList'), toast=$('#toast'), chartEmpty=$('#chartEmpty');
let bars=[], zones=[], selected=-1, selectedZone=null, showZones=true, showNumbers=true, mode='bidask', live=false, replayMode=false, toastTimer;
let levels=[], analysisMeta=null, hasAutoScrolled=false;
let horizontalZoom=1, verticalZoom=1, footprintZoomX=1, footprintZoomY=1, chartDrag=null, suppressChartClickUntil=0;
// The vertical band the price axis is currently showing. Kept between renders so a tick inside it
// does not move the series; only a new extreme, a zoom change or another instrument rebuilds it.
let chartRange=null;
const chartViewport=chart.parentElement;
// Keep the delta pane under the candles when the chart is scrolled sideways, in either direction.
chartViewport.addEventListener('scroll',()=>{const wrap=$('#deltaPaneWrap');if(wrap&&wrap.scrollLeft!==chartViewport.scrollLeft)wrap.scrollLeft=chartViewport.scrollLeft;});
$('#deltaPaneWrap')?.addEventListener('scroll',event=>{const wrap=event.currentTarget;if(wrap.scrollLeft!==chartViewport.scrollLeft)chartViewport.scrollLeft=wrap.scrollLeft;});
// The user's footprint options (published by settings-client at module init and on every save).
// The live path recomputes the forming bar with them, so a changed setting shows at once.
const footprintOptions=()=>window.gold3poSettings?.footprint&&Object.keys(window.gold3poSettings.footprint).length?window.gold3poSettings.footprint:DEFAULT_FOOTPRINT_OPTIONS;
// The footprint's source precision as the server built the bars: the broker tick size when MT5 reported
// one, otherwise 0.1. The live forming bar uses the same step so it matches the bars around it.
const footprintStep=()=>{const step=Number(analysisMeta?.footprintStep);return Number.isFinite(step)&&step>0&&step<=100?step:0.1;};
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
 const before=chartViewport.scrollLeft;
 const rect=chartViewport.getBoundingClientRect();
 const localX=anchorClientX===null?chartViewport.clientWidth/2:clamp(anchorClientX-rect.left,0,chartViewport.clientWidth);
 horizontalZoom=clamp(next,CHART_ZOOM.min,CHART_ZOOM.max);
 renderChart();
 const newWidth=Math.max(1,chart.getBoundingClientRect().width);
 chartViewport.scrollLeft=zoomScrollAnchor({scrollLeft:before,viewportWidth:chartViewport.clientWidth,widthBefore:oldWidth,widthAfter:newWidth,anchorX:localX});
 updateChartZoomControls();
}
function changeVerticalZoom(next){verticalZoom=clamp(next,CHART_ZOOM.min,CHART_ZOOM.max);chartRange=null;renderChart();updateChartZoomControls();}
// Dragging the price scale fires on every pointermove; one render per frame keeps the drag smooth.
let verticalDragFrame=0,pendingVerticalZoom=null;
function scheduleVerticalZoom(next){
 pendingVerticalZoom=clamp(next,CHART_ZOOM.min,CHART_ZOOM.max);
 if(verticalDragFrame)return;
 verticalDragFrame=requestAnimationFrame(()=>{verticalDragFrame=0;if(pendingVerticalZoom===null)return;changeVerticalZoom(pendingVerticalZoom);pendingVerticalZoom=null;});
}
function updateFootprintZoomControls(){
 const x=$('#footZoomXReset'),y=$('#footZoomYReset');
 if(x)x.textContent='X '+Math.round(footprintZoomX*100)+'%';
 if(y)y.textContent='Y '+Math.round(footprintZoomY*100)+'%';
}
function changeFootprintZoom(axis,next){
 if(axis==='x')footprintZoomX=clamp(next,0.16,3.5);
 else if(axis==='y')footprintZoomY=clamp(next,0.22,3);
 else if(axis==='both'){footprintZoomX=clamp(next.x,0.16,3.5);footprintZoomY=clamp(next.y,0.22,3);}
 renderFootprint();updateFootprintZoomControls();
}
function fitFootprintOverview(){
 if(!bars.length)return;
 const availableW=Math.max(320,(grid.clientWidth||900)-24-68-92);
 const targetCols=Math.min(bars.length,120);
 const idealW=clamp(Math.floor(availableW/Math.max(targetCols,1)),10,64);
 const availableH=Math.max(260,(grid.clientHeight||520)-72);
 const sample=bars.slice(-targetCols).map(barFootprint);
 const uniquePrices=new Set();
 for(const b of sample)for(const r of (Array.isArray(b.levels)?b.levels:[]))if(r.bid||r.ask||r.unknown)uniquePrices.add(Number(r.price).toFixed(8));
 const rowCount=Math.max(12,uniquePrices.size);
 const idealH=clamp(Math.floor(availableH/rowCount),5,24);
 changeFootprintZoom('both',{x:idealW/52,y:idealH/22});
}
function bindChartNavigation(){
 if(!chartViewport||chartViewport.dataset.navigationBound==='1')return;
 chartViewport.dataset.navigationBound='1';
 // TradingView gesture set: the wheel zooms the time axis around the cursor (Shift zooms price),
 // dragging pans, dragging the price scale stretches it, and a double click fits both back to 100%.
 chartViewport.addEventListener('wheel',event=>{
  if(!bars.length)return;
  const intent=wheelIntent({deltaY:event.deltaY,shiftKey:event.shiftKey});
  if(!intent)return;
  event.preventDefault();
  if(intent.axis==='price')scheduleVerticalZoom(verticalZoom*intent.factor);
  else changeHorizontalZoom(horizontalZoom*intent.factor,event.clientX);
 },{passive:false});
 // A double click is recognised here rather than from the dblclick event: selecting a candle
 // re-renders the SVG between the two clicks, and the browser then never reports a dblclick.
 let lastTapAt=0,lastTapX=0,lastTapY=0;
 function fitScales(){
  if(!bars.length)return;
  horizontalZoom=1;verticalZoom=1;chartRange=null;renderChart();
  chartViewport.scrollLeft=chartViewport.scrollWidth;updateChartZoomControls();
 }
 chartViewport.addEventListener('pointerdown',event=>{
  if(event.button!==0)return;
  const tapAt=performance.now();
  if(tapAt-lastTapAt<320&&Math.abs(event.clientX-lastTapX)<8&&Math.abs(event.clientY-lastTapY)<8){
   lastTapAt=0;fitScales();return;
  }
  lastTapAt=tapAt;lastTapX=event.clientX;lastTapY=event.clientY;
  // The price scale is drawn at the end of the series, so it is only grabbable while the chart is
  // pinned to the newest bar. Scrolled back into history, a drag pans instead.
  const viewportRect=chartViewport.getBoundingClientRect();
  const atNewest=chartViewport.scrollLeft+chartViewport.clientWidth>=chartViewport.scrollWidth-2;
  if(atNewest&&event.clientX>viewportRect.right-CHART_AXIS.right){
   chartDrag={axis:'price',startY:event.clientY,startZoom:verticalZoom,moved:false};
   chartViewport.classList.add('chart-price-panning');
   return;
  }
  chartDrag={startX:event.clientX,startScrollLeft:chartViewport.scrollLeft,moved:false};
  chartViewport.classList.add('chart-panning');
 });
 window.addEventListener('pointermove',event=>{
  if(!chartDrag)return;
  if(chartDrag.axis==='price'){
   const delta=chartDrag.startY-event.clientY;
   if(Math.abs(delta)>2)chartDrag.moved=true;
   if(chartDrag.moved)scheduleVerticalZoom(chartDrag.startZoom*Math.exp(delta/260));
   return;
  }
  const delta=event.clientX-chartDrag.startX;
  if(Math.abs(delta)>3)chartDrag.moved=true;
  if(chartDrag.moved){chartViewport.scrollLeft=chartDrag.startScrollLeft-delta;chartViewport.classList.add('is-dragging');}
 });
 const endDrag=()=>{
  if(chartDrag?.moved)suppressChartClickUntil=performance.now()+250;
  chartDrag=null;chartViewport.classList.remove('chart-panning','is-dragging','chart-price-panning');
 };
 window.addEventListener('pointerup',endDrag);
 window.addEventListener('pointercancel',endDrag);
 chartViewport.addEventListener('dblclick',fitScales);
}
bindChartNavigation();
$('#chartZoomOut')?.addEventListener('click',()=>changeHorizontalZoom(horizontalZoom/1.2));
$('#chartZoomIn')?.addEventListener('click',()=>changeHorizontalZoom(horizontalZoom*1.2));
$('#chartZoomReset')?.addEventListener('click',()=>{horizontalZoom=1;renderChart();chartViewport.scrollLeft=chartViewport.scrollWidth;updateChartZoomControls();});
$('#chartPriceZoomOut')?.addEventListener('click',()=>changeVerticalZoom(verticalZoom/1.2));
$('#chartPriceZoomIn')?.addEventListener('click',()=>changeVerticalZoom(verticalZoom*1.2));
$('#chartPriceZoomReset')?.addEventListener('click',()=>changeVerticalZoom(1));
window.addEventListener('resize',()=>{renderChart();renderFootprint();});
function clearDeltaPane(){const svg=$('#deltaPane');if(svg)svg.innerHTML='';}
// The pane shares the chart's scale, so a cluster and its cumulative delta always line up.
function renderDeltaPane(scale){
 const svg=$('#deltaPane'),wrap=$('#deltaPaneWrap');
 if(!svg||!wrap)return;
 const pane=deltaPaneMarkup(bars,scale);
 svg.setAttribute('viewBox',`0 0 ${pane.svgWidth} ${pane.height}`);
 svg.style.width=pane.svgWidth+'px';
 svg.innerHTML=pane.html;
 if(wrap.scrollLeft!==chartViewport.scrollLeft)wrap.scrollLeft=chartViewport.scrollLeft;
}
function renderChart(){
 if(!bars.length){chart.innerHTML='';chart.setAttribute('viewBox','0 0 1000 390');chart.style.width='100%';clearDeltaPane();setEmptyState(true);return;}
 setEmptyState(false);
 const left=64;
 // The chart fills the panel at any window width (up to 4K) and compresses history into it: a bar
 // may shrink to 3px on a laptop panel and 2px on a 4K one before the series becomes a scroll strip.
 const wrapWidth=Math.max(320,Math.round((chart.parentElement?.clientWidth||960)-16));
 const scale=chartScale({panelWidth:wrapWidth,bars:bars.length,left,zoom:horizontalZoom});
 const width=scale.width, step=scale.step, svgWidth=scale.svgWidth;
 const allPrices=bars.flatMap(b=>[b.h,b.l]);
 // Include every plotted liquidity zone in the visible price extent. Otherwise zones above/below
 // the candle range are clipped by the chart's auto-scale and appear to be missing in MT5 parity checks.
 if(showZones)for(const zone of zones){if(Number.isFinite(Number(zone.high)))allPrices.push(Number(zone.high));if(Number.isFinite(Number(zone.low)))allPrices.push(Number(zone.low));}
 const plotted=allPrices.map(Number).filter(value=>Number.isFinite(value));
 if(!plotted.length){setEmptyState(true);return;}
 // A sticky band: the axis only grows when price leaves it, so a live tick never shifts the series.
 const range=priceRange({prices:plotted,previous:chartRange,zoom:verticalZoom});
 chartRange=range;
 const min=range.min,max=range.max;
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
 renderDeltaPane(scale);
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
const MAX_FOOTPRINT_ROWS = 96;
function effectiveRowStep(){
 const row=Number(analysisMeta?.rowStep);
 if(Number.isFinite(row)&&row>0&&row<=1000)return row;
 const base=footprintStep(),opts=footprintOptions();
 const mult=Number(analysisMeta?.effectiveTicksPerRow)||(opts.autoStep?1:(opts.ticksPerRow||1));
 return Number((base*Math.max(1,mult)).toFixed(8));
}
function buildLevelLookup(b){
 if(!Array.isArray(b?.levels))return null;
 const map=new Map();
 for(const l of b.levels)map.set(Number(l.price).toFixed(8),l);
 return map;
}
function levelOf(b,price){
 if(!Array.isArray(b?.levels))return{bid:0,ask:0,unknown:0,total:0};
 const key=Number(price).toFixed(8);
 const v=b._levelLookup?b._levelLookup.get(key):b.levels.find(l=>near(l.price,price));
 return v?{bid:v.bid||0,ask:v.ask||0,unknown:v.unknown||0,total:(v.bid||0)+(v.ask||0)+(v.unknown||0)}:{bid:0,ask:0,unknown:0,total:0};
}
function barFootprint(b,overrideTicks=null){
 if(!overrideTicks&&b.poc!==undefined&&b.valueArea!==undefined&&Array.isArray(b.levels))return b;
 if(!Array.isArray(b?.levels))return b;
 const opts={...footprintOptions(),h:b.h,l:b.l,c:b.c,priceStep:footprintStep()};
 if(overrideTicks&&overrideTicks>=1){opts.ticksPerRow=overrideTicks;opts.autoStep=false;}
 return {...b,...footprintOf(b.levels,opts)};
}
// One footprint cell's contents: the bid/ask halves plus the unclassified marker. The full render
// and the live column patch both call it, so a patched cell prints exactly what a rebuild would.
function footCellContent(v,{mode,showNumbers,bidAlpha=0,askAlpha=0,bidPct=0,askPct=0}){
 if(mode!=='bidask')return null;
 if(!showNumbers)return '<span class="foot-side bid-side" data-side="bid"></span><span class="foot-side ask-side" data-side="ask"></span>';
 let content='<span class="foot-side bid-side" data-side="bid" style="--side-intensity:'+bidAlpha.toFixed(3)+';--side-pct:'+bidPct+'%">'+(v.bid>0?fmt(v.bid,0):'')+'</span><span class="foot-side ask-side" data-side="ask" style="--side-intensity:'+askAlpha.toFixed(3)+';--side-pct:'+askPct+'%">'+(v.ask>0?fmt(v.ask,0):'')+'</span>';
 if(v.unknown>0){
  const hasSides=v.bid>0||v.ask>0;
  content+='<span class="foot-unknown '+(hasSides?'mixed':'only')+'" title="Неопределённая сторона: '+fmt(v.unknown,0)+'">'+(hasSides?'?':'? '+fmt(v.unknown,0))+'</span>';
 }
 return content;
}
const sideIntensity=(value,maximum)=>value>0?Math.min(.9,.08+.8*Math.pow(value/maximum,.58)):0;
const sidePercent=(value,maximum)=>value>0?Math.min(100,Math.max(8,Math.round(100*value/maximum))):0;
// One full footprint cell, including its marks and classes. A rebuild and a live patch both call
// it, so a patched column is identical to a re-rendered one.
function footCellMarkup(b,p,index,ctx){
 const {mode,showNumbers,scale,bidScale,askScale,step,priceDigits,selected,formingIndex}=ctx;
 const v=levelOf(b,p),total=v.total||(v.bid+v.ask+v.unknown),empty=total<=0;
 const intensity=total>0?Math.min(.85,.07+.68*Math.pow(total/scale,.65)):0;
 const bidAlpha=sideIntensity(v.bid,bidScale),askAlpha=sideIntensity(v.ask,askScale);
 const bidPct=sidePercent(v.bid,bidScale),askPct=sidePercent(v.ask,askScale);
 const priceLabel=value=>fmt(value,priceDigits);
 const isPoc=b.poc!=null&&near(b.poc,p),inVa=!!b.valueArea&&p<=b.valueArea.high+1e-9&&p>=b.valueArea.low-1e-9;
 const imbalance=b.imbalances?.find(x=>near(x.price,p))?.side||null;
 const stacked=!!imbalance&&(b.stackedImbalances||[]).some(item=>item.side===imbalance&&Array.isArray(item.prices)&&item.prices.some(price=>near(price,p)));
 const absorbed=(b.absorbedLevels||[]).some(x=>near(x.price,p));
 const levelRows=Array.isArray(b.levels)?b.levels:[];
 const unfinished=(levelRows.length&&near(levelRows[0].price,p)&&b.unfinishedHigh)||(levelRows.length&&near(levelRows.at(-1).price,p)&&b.unfinishedLow);
 let content='',cls='';
 if(mode==='bidask'){
  content=footCellContent(v,{mode,showNumbers,bidAlpha,askAlpha,bidPct,askPct});
  cls='bidask';
  if(v.unknown>0&&v.bid+v.ask===0)cls+=' unknown-only';
 }else{
  const cell=footprintCell(v,mode);
  content=showNumbers?cell.text:'';
  cls=cell.tone==='positive'?'delta-positive':cell.tone==='negative'?'delta-negative':'volume-cell';
 }
 if(empty)cls+=' empty-level';
 if(imbalance)cls+=' imbalance-'+imbalance;
 if(stacked)cls+=' foot-stacked-'+imbalance;
 if(isPoc)cls+=' foot-poc';
 if(inVa)cls+=' foot-va';
 if(absorbed)cls+=' foot-absorbed';
 if(unfinished)cls+=' foot-unfinished';
 if(index===formingIndex)cls+=' foot-forming';
 const part=candlePart(b,p,step);
 cls+=' candle-'+part+(part==='body'?(b.c>=b.o?' candle-up':' candle-down'):'');
 const marks=[isPoc?'POC':'',inVa?'зона стоимости':'',imbalance?(imbalance==='buy'?'имбаланс покупателей':'имбаланс продавцов'):'',stacked?'стек имбалансов':'',absorbed?'поглощение':'',unfinished?'незакрытый аукцион':'',v.unknown>0?'неопределённая сторона: '+fmt(v.unknown,0):''].filter(Boolean).join(' · ');
 const title='Бид '+v.bid+'; аск '+v.ask+'; без стороны '+v.unknown+(marks?' · '+marks:'');
 const aria='Свеча '+(index+1)+', цена '+priceLabel(p)+', бид '+v.bid+', аск '+v.ask+', без стороны '+v.unknown+(marks?', '+marks:'');
 return '<button class="foot-cell '+cls+' '+(index===selected?'active':'')+'" data-index="'+index+'" data-price="'+p+'" data-bid="'+v.bid+'" data-ask="'+v.ask+'" data-unknown="'+v.unknown+'" style="--intensity:'+intensity.toFixed(3)+'" title="'+title.replace(/"/g,'&quot;')+'" aria-label="'+aria.replace(/"/g,'&quot;')+'" '+(empty?'disabled aria-hidden="true"':'')+'>'+content+(isPoc?'<i class="poc-mark">◆</i>':'')+'</button>';
}
// Marks that colour a whole column: while they stay identical, a tick can only change numbers.
function footMarkSignature(foot){
 if(!foot)return '';
 const va=foot.valueArea?Number(foot.valueArea.low).toFixed(8)+':'+Number(foot.valueArea.high).toFixed(8):'';
 const imb=(foot.imbalances||[]).map(x=>x.side+Number(x.price).toFixed(8)).join('|');
 const stk=(foot.stackedImbalances||[]).map(x=>x.side+(x.prices||[]).length).join('|');
 const abs=(foot.absorbedLevels||[]).map(x=>Number(x.price).toFixed(8)).join('|');
 return [foot.poc!=null?Number(foot.poc).toFixed(8):'',va,imb,stk,abs,foot.unfinishedHigh?'H':'',foot.unfinishedLow?'L':''].join('/');
}
// What the last render left on screen, so a live tick can rewrite the forming column instead of
// rebuilding every row of the ladder.
let liveColumnState=null;
function patchLiveFootprint(){
 const state=liveColumnState;
 if(!state||!bars.length||mode!=='bidask'||!showNumbers)return false;
 if(state.index!==bars.length-1)return false;
 const foot=barFootprint(bars[bars.length-1]);
 if(!Array.isArray(foot.levels)||!foot.levels.length)return false;
 // Rows carry the broker's own precision, so a level is matched to the rendered ladder by price
 // within half a step instead of by an exact string: float noise must not force a rebuild.
 const snap=price=>{
  let best=null,delta=Infinity;
  for(const candidate of state.rows){
   const d=Math.abs(candidate-price);
   if(d<delta){delta=d;best=candidate;}
  }
  return delta<=state.step/2+1e-9?best:null;
 };
 const index=state.index,targets=[];
 for(const row of foot.levels){
  const snapped=snap(Number(row.price));
  // A price row the ladder does not carry yet changes the rows of every column: rebuild.
  if(snapped===null)return false;
  const cell=grid.querySelector('.foot-cell[data-index="'+index+'"][data-price="'+snapped+'"]');
  if(!cell)return false;
  targets.push({price:snapped,cell});
 }
 // The heat map is normalised over the whole window, so the scales the new column needs are taken
 // before writing; rescaleFootprintHeat then keeps every other column's colour consistent.
 let scale=state.scale,bidScale=state.bidScale,askScale=state.askScale;
 for(const row of foot.levels){
  const bid=Number(row.bid)||0,ask=Number(row.ask)||0,total=bid+ask+(Number(row.unknown)||0);
  if(total>scale)scale=total;
  if(bid>bidScale)bidScale=bid;
  if(ask>askScale)askScale=ask;
 }
 const step=state.step||effectiveRowStep();
 const ctx={mode,showNumbers,scale,bidScale,askScale,step,priceDigits:clamp(Math.ceil(-Math.log10(step)),2,6),selected,formingIndex:index};
 foot._levelLookup=buildLevelLookup(foot);
 for(const {price,cell} of targets)cell.outerHTML=footCellMarkup(foot,price,index,ctx);
 state.scale=scale;state.bidScale=bidScale;state.askScale=askScale;
 state.marks=footMarkSignature(foot);
 const deltaCell=grid.querySelector('.foot-delta[data-index="'+index+'"]');
 if(deltaCell){
  const d=(foot.unknown||0)>0?null:(foot.delta??barDelta(bars[bars.length-1]));
  deltaCell.textContent=d===null?'—':((d>0?'+':'')+fmt(d,0));
  deltaCell.className='foot-delta '+(d===null?'':d>=0?'positive':'negative')+(index===selected?' active':'');
 }
 return true;
}

function renderFootprint(){
 if(!bars.length){liveColumnState=null;grid.innerHTML='<div class="detail-caption">Тики брокера ещё не поступили. Подключите MT5, чтобы построить футпринт.</div>';return;}
 // Keep the footprint as a shared price ladder: every candle stays on the same vertical price scale.
 // Each traded cell is rendered as two independent heatmap sides (Bid / Ask), not one blended total.
 // ATAS-style zoom range: compresses down to 10x5px micro-clusters (up to 160 candles) for the full
 // picture, or stretches up to 140x64px for reading individual Bid x Ask prints.
 const available=Math.max(320,(grid.clientWidth||900)-24),cellWidth=clamp(Math.round(58*footprintZoomX),10,140),maxCols=Math.max(3,Math.min(160,Math.floor((available-68-92)/Math.max(cellWidth,10))));
 const windowSize=maxCols,start=Math.max(0,Math.min(Math.max(0,bars.length-windowSize),selected-Math.floor(windowSize/2))),visible=bars.slice(start,start+windowSize),offset=start;
 const opts=footprintOptions(),sourceStep=footprintStep(),serverStep=effectiveRowStep();
 const serverTicks=Math.max(1,Math.round(serverStep/sourceStep));
 const targetAutoRows=clamp(Math.round(28/Math.max(0.4,footprintZoomY)),10,56);
 const autoMult=opts.autoStep?autoTicksPerRow(visible,sourceStep,targetAutoRows):null;
 const overrideTicks=(autoMult&&autoMult>serverTicks)?autoMult:null;
 const feet=visible.map(b=>{const f=barFootprint(b,overrideTicks);f._levelLookup=buildLevelLookup(f);return f;});
 const activeTicks=overrideTicks||serverTicks;
 const step=Number((sourceStep*activeTicks).toFixed(8));
 const autoOpt=document.querySelector('#footClusterStep option[value="auto"]');
 if(autoOpt){const stepDigits=step<0.1?2:step<1?2:step<10?1:0;autoOpt.textContent='Авто ('+fmt(step,stepDigits)+')';}
 const traded=new Map();
 for(const b of feet)for(const row of (Array.isArray(b.levels)?b.levels:[])){
  if(!(row.bid||row.ask||row.unknown))continue;
  const price=Number(row.price),key=price.toFixed(8);
  if(!traded.has(key))traded.set(key,price);
 }
 let priceRows=[...traded.values()].sort((a,b)=>b-a);
 if(!priceRows.length){liveColumnState=null;grid.innerHTML='<div class="detail-caption">В выбранном окне нет сделок: футпринт появится с первыми тиками.</div>';return;}
 let clippedNotice='';
 if(priceRows.length>MAX_FOOTPRINT_ROWS){
  const focusBar=feet[clamp(selected-offset,0,feet.length-1)]||feet.at(-1);
  const focusPrice=Number(focusBar?.poc??focusBar?.c??priceRows[Math.floor(priceRows.length/2)]);
  let bestIdx=0,bestDist=Infinity;
  for(let i=0;i<priceRows.length;i++){const d=Math.abs(priceRows[i]-focusPrice);if(d<bestDist){bestDist=d;bestIdx=i;}}
  const half=Math.floor(MAX_FOOTPRINT_ROWS/2);
  const loIdx=clamp(bestIdx-half,0,Math.max(0,priceRows.length-MAX_FOOTPRINT_ROWS));
  clippedNotice=' · показано '+MAX_FOOTPRINT_ROWS+' из '+priceRows.length+' уровней (включите «Авто» для полной свечи)';
  priceRows=priceRows.slice(loIdx,loIdx+MAX_FOOTPRINT_ROWS);
 }
 // Auto-fit row height so the entire visible range fits in the panel without vertical scrolling
 // (like ATAS), while still letting Y+/Y- stretch or compress rows.
 const panelHeight=Math.max(360,grid.clientHeight||500)-112;
 const fitRowHeight=priceRows.length<=48?clamp(Math.floor(panelHeight/Math.max(1,priceRows.length)),15,26):20;
 const rowHeight=Math.abs(footprintZoomY-1)<0.02?fitRowHeight:clamp(Math.round(fitRowHeight*footprintZoomY),6,64);
 const isMicro=cellWidth<22||rowHeight<10,isCompact=!isMicro&&(cellWidth<38||rowHeight<14);
 // Data quality is shown, never repaired by inventing prices or distributing OHLC over empty rows.
 const totalSourceTicks=feet.reduce((sum,b)=>sum+(Number(b.tickCount)||0),0);
 const totalSourceLevels=feet.reduce((sum,b)=>sum+(Array.isArray(b.levels)?b.levels.length:0),0);
 const sparseBars=feet.filter(b=>(Array.isArray(b.levels)?b.levels.length:0)<3).length;
 const volumeKind=String(analysisMeta?.volumeKind||'');
 const sourceLabel=volumeKind.includes('exchange_trade_size')
  ?'ИСТОЧНИК · БИРЖЕВЫЕ СДЕЛКИ / ОБЪЁМ КОНТРАКТОВ · ШАГ '+fmt(step,step<1?2:1)
  :'ИСТОЧНИК · MT5 OTC / ТИКОВАЯ АКТИВНОСТЬ, НЕ БИРЖЕВОЙ ОБЪЁМ · ШАГ '+fmt(step,step<1?2:1);
 const sourceQuality=(sparseBars
  ?'РЕДКИЕ ДАННЫЕ · '+sparseBars+'/'+feet.length+' свечей имеют менее 3 реальных ценовых уровней · пропуски не интерполируются'
  :'ПЛОТНОСТЬ · '+totalSourceTicks+' исходных тиков / '+totalSourceLevels+' кластеров')+clippedNotice;
 const sourceStatus='<div class="footprint-source-status '+(sparseBars?'is-sparse':'is-dense')+'" role="status" aria-live="polite"><strong>'+sourceLabel+'</strong><span>'+sourceQuality+'</span></div>';
 const allLevels=feet.flatMap(b=>Array.isArray(b.levels)?b.levels:[]);
 const scale=Math.max(1,...feet.map(b=>Number(b.maxLevelVolume)||0));
 const bidScale=Math.max(1,...allLevels.map(row=>Number(row.bid)||0));
 const askScale=Math.max(1,...allLevels.map(row=>Number(row.ask)||0));
 const profile=sessionProfile(bars,{priceStep:sourceStep,options:{...opts,ticksPerRow:activeTicks,autoStep:false}});
 const currentProfile=profile.current;
 const profileRows=new Map((currentProfile?.levels||[]).map(row=>[Number(row.price).toFixed(8),row]));
 const profileMax=Math.max(1,...(currentProfile?.levels||[]).map(row=>row.total));
 const va=currentProfile?.valueArea||null;
 const priceDigits=clamp(Math.ceil(-Math.log10(step)),2,6),priceLabel=p=>fmt(p,priceDigits);
 const densityClass=isMicro?' is-micro':isCompact?' is-compact':'';
 const labelStride=cellWidth<16?6:cellWidth<26?3:cellWidth<38?2:1;
 const cols=visible.length,template='68px repeat('+cols+','+cellWidth+'px) 92px',minWidth=68+cols*cellWidth+92;
 const head='<div class="foot-row foot-head" style="grid-template-columns:'+template+';min-width:'+minWidth+'px"><div class="price-level">ЦЕНА</div>'+visible.map((b,i)=>{const levels=Array.isArray(b.levels)?b.levels.length:0,ticks=Number(b.tickCount)||0;const show=i%labelStride===0||offset+i===selected;return '<div class="bar-head '+(offset+i===selected?'active':'')+'" data-index="'+(offset+i)+'" data-source-ticks="'+ticks+'" data-source-levels="'+levels+'" title="'+timeLabel(b.time,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' · исходных тиков: '+ticks+' · кластеров: '+levels+'">'+(show?'#'+String(offset+i+1).padStart(3,'0'):'')+'</div>';}).join('')+'<div class="foot-profile-head">ПРОФИЛЬ</div></div>';
 const cellCtx={mode,showNumbers,scale,bidScale,askScale,step,priceDigits,selected,formingIndex:bars.length-1};
 const rows=priceRows.map((p,rowIdx)=>'<div class="foot-row" style="grid-template-columns:'+template+';min-width:'+minWidth+'px"><div class="price-level" data-price="'+p+'">'+((!isMicro||rowIdx%3===0)?priceLabel(p):'')+'</div>'+feet.map((b,i)=>footCellMarkup(b,p,offset+i,cellCtx)).join('')+(function(){
  const row=profileRows.get(Number(p).toFixed(8));
  if(!row||!row.total)return '<div class="foot-profile empty"></div>';
  const isPoc=va&&near(currentProfile.poc,p),inVa=va&&p<=va.high+1e-9&&p>=va.low-1e-9;
  const isVah=va&&near(va.high,p),isVal=va&&near(va.low,p);
  const width=Math.max(1,Math.round(100*row.total/profileMax));
  return '<div class="foot-profile '+(inVa?'va ':'')+(isPoc?'poc':'')+'" title="Профиль сессии: '+fmt(row.total,0)+' · '+(isPoc?'POC':'внутри зоны стоимости')+'"><i style="width:'+width+'%"></i>'+(isVah?'<b>VAH</b>':isVal?'<b>VAL</b>':isPoc?'<b>POC</b>':'')+'</div>';
 })()+'</div>').join('');
 const deltas='<div class="foot-row foot-deltas" style="grid-template-columns:'+template+';min-width:'+minWidth+'px"><div class="price-level">Δ СВЕЧИ</div>'+feet.map((b,i)=>{const d=b.unknown>0?null:(b.delta??barDelta(b));const show=!isMicro||i%labelStride===0||offset+i===selected;return '<div class="foot-delta '+(d===null?'':d>=0?'positive':'negative')+' '+(offset+i===selected?'active':'')+'" data-index="'+(offset+i)+'" title="Δ '+(d===null?'—':((d>0?'+':'')+fmt(d,0)))+'">'+(show?(d===null?'—':((d>0?'+':'')+fmt(d,0))):'')+'</div>';}).join('')+'<div class="foot-profile-total">'+(currentProfile?fmt(currentProfile.volume,0):'—')+'</div></div>';
 const times='<div class="foot-row foot-times" style="grid-template-columns:'+template+';min-width:'+minWidth+'px"><div class="price-level">ВРЕМЯ</div>'+visible.map((b,i)=>{const show=i%labelStride===0||offset+i===selected;return '<button class="bar-time '+(offset+i===selected?'active':'')+'" data-index="'+(offset+i)+'">'+(show?timeLabel(b.time,{hour:'2-digit',minute:'2-digit',timeZone:'UTC'},'toLocaleTimeString'):'')+'</button>';}).join('')+'<div class="foot-profile-head">СЕССИЯ</div></div>';
 grid.innerHTML=sourceStatus+'<div class="footprint-table'+densityClass+'" style="min-width:'+minWidth+'px;--footprint-row-height:'+rowHeight+'px">'+head+deltas+rows+times+'</div>';
 updateFootprintZoomControls();
 // Keep the newest traded price in view unless the trader has taken over scrolling.
 if(grid.dataset.autoScroll!=='0'&&grid.scrollHeight>grid.clientHeight+16){
  const target=grid.querySelector('.foot-cell.foot-forming.foot-poc')||[...grid.querySelectorAll('.foot-cell.foot-forming:not(.empty-level)')].find(node=>node.textContent.trim());
  if(target){const row=target.closest('.foot-row'),box=grid.getBoundingClientRect(),rect=row.getBoundingClientRect();
   if(rect.top<box.top+50||rect.bottom>box.bottom-50)grid.scrollTop+=rect.top-box.top-Math.round((box.height-rect.height)/2);}
 }
 // Remember what this render put on screen: while the ladder, the marks and the window hold, a
 // live tick only has to rewrite the forming column.
 const lastVisible=offset+visible.length-1;
 liveColumnState=lastVisible===bars.length-1
  ?{index:lastVisible,rows:priceRows.map(Number),step,scale,bidScale,askScale,marks:footMarkSignature(feet.at(-1))}
  :null;
}
grid.addEventListener('click',event=>{
 const node=event.target.closest('[data-index]');
 if(node&&grid.contains(node)&&!node.disabled)select(Number(node.dataset.index));
});
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
$('#footZoomXOut')?.addEventListener('click',()=>changeFootprintZoom('x',footprintZoomX/1.25));
$('#footZoomXIn')?.addEventListener('click',()=>changeFootprintZoom('x',footprintZoomX*1.25));
$('#footZoomXReset')?.addEventListener('click',()=>changeFootprintZoom('x',1));
$('#footZoomYOut')?.addEventListener('click',()=>changeFootprintZoom('y',footprintZoomY/1.25));
$('#footZoomYIn')?.addEventListener('click',()=>changeFootprintZoom('y',footprintZoomY*1.25));
$('#footZoomYReset')?.addEventListener('click',()=>changeFootprintZoom('y',1));
$('#footZoomFit')?.addEventListener('click',()=>fitFootprintOverview());
grid.addEventListener('wheel',event=>{
 const factor=event.deltaY<0?1.15:1/1.15;
 if(event.altKey){event.preventDefault();changeFootprintZoom('both',{x:footprintZoomX*factor,y:footprintZoomY*factor});}
 else if(event.ctrlKey){event.preventDefault();changeFootprintZoom(event.shiftKey?'y':'x',(event.shiftKey?footprintZoomY:footprintZoomX)*factor);}
 else if(event.shiftKey){event.preventDefault();changeFootprintZoom('y',footprintZoomY*factor);}
},{passive:false});
$('#footprintModes').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.mode;$('#footprintModes').querySelectorAll('button').forEach(x=>x.classList.toggle('selected',x===b));renderFootprint();}));
$('#resetView').addEventListener('click',()=>{replayMode=false;showZones=true;showNumbers=true;mode='bidask';horizontalZoom=1;verticalZoom=1;chartRange=null;footprintZoomX=1;footprintZoomY=1;selectedZone=null;$('#zonesToggle').setAttribute('aria-pressed','true');$('#numbersToggle').setAttribute('aria-pressed','true');$('#zonesToggle').classList.remove('is-off');renderZones();$('#footprintModes').querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b.dataset.mode==='bidask'));select(bars.length-1);chartViewport.scrollLeft=chartViewport.scrollWidth;updateChartZoomControls();notify('Вид сброшен');});
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
panelResizer?.addEventListener('keydown',event=>{
 if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
 event.preventDefault();splitRatio=clamp(splitRatio+(event.key==='ArrowRight'?0.03:-0.03),0.32,0.68);
 workspace.style.setProperty('--chart-split',`${Math.round(splitRatio*100)}%`);
 try{localStorage.setItem('gold3po-split',String(splitRatio));}catch{}
 renderChart();renderFootprint();
});
applyWorkspaceLayout();
// A streamed tick updates the forming bar in place: the last footprint column and the last
// candle move between authoritative refetches instead of waiting for the next 1.5 s poll.
let liveFrame=0,liveRenderedAt=0,lastLiveTick=null,liveRuleBid=null,liveRuleAsk=null,liveRuleSide=null;
function scheduleLiveRender(){
 if(liveFrame)return;
 const wait=Math.max(0,180-(performance.now()-liveRenderedAt));
 liveFrame=setTimeout(()=>{liveFrame=0;liveRenderedAt=performance.now();renderChart();if(!patchLiveFootprint())renderFootprint();if(selected===bars.length-1)renderInspector();},wait);
}
function applyLiveTick(event){
 if(replayMode||!bars.length||!event)return;
 lastLiveTick=event;
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
 const bidNum=Number(event.bid),askNum=Number(event.ask),lastNum=Number(event.last);
 let side=['buy','sell'].includes(event.aggressorSide)?event.aggressorSide:null;
 if(!side&&Number.isFinite(bidNum)&&Number.isFinite(lastNum)&&lastNum<=bidNum){
  if(liveRuleBid!==null){
   if(bidNum>liveRuleBid)side='buy';
   else if(bidNum<liveRuleBid)side='sell';
   else if(Number.isFinite(askNum)&&liveRuleAsk!==null&&askNum!==liveRuleAsk)side=askNum>liveRuleAsk?'buy':'sell';
   else if(liveRuleSide)side=liveRuleSide;
  }
  liveRuleBid=bidNum;
  if(Number.isFinite(askNum))liveRuleAsk=askNum;
  if(side)liveRuleSide=side;
 }
 const rowStep=effectiveRowStep();
 const state={levels:bar.levelMap,o:bar.o,h:bar.h,l:bar.l,c:bar.c,volume:bar.volume||0,bid:bar.bid||0,ask:bar.ask||0,unknown:bar.unknown||0,tickCount:bar.tickCount||0};
 applyTickToBar(state,{last:lastNum,volume:footprintTickVolume({...event,aggressorSide:side||event.aggressorSide}),aggressorSide:side||event.aggressorSide,flags:event.flags},rowStep);
 const foot=footprintOf(state.levels,{...footprintOptions(),autoStep:false,ticksPerRow:1,priceStep:rowStep,h:state.h,l:state.l,c:state.c});
 bar.levelMap=state.levels;
 Object.assign(bar,{o:state.o,h:state.h,l:state.l,c:state.c,volume:state.volume,bid:state.bid,ask:state.ask,unknown:state.unknown,tickCount:state.tickCount,
  levels:foot.levels,delta:foot.delta,deltaRatio:foot.deltaRatio,poc:foot.poc,valueArea:foot.valueArea,imbalances:foot.imbalances,
  stackedImbalances:foot.stackedImbalances,absorbedLevels:foot.absorbedLevels,unfinishedHigh:foot.unfinishedHigh,unfinishedLow:foot.unfinishedLow,maxLevelVolume:foot.maxLevelVolume});
 bar.cumulativeDelta=(bars[bars.length-2]?.cumulativeDelta||0)+bar.delta;
 scheduleLiveRender();
}
// The aggregate is built on the server a moment before it reaches this listener, and a tick streamed
// in between is newer than it. Replacing the forming bar wholesale would roll the chart back to a
// price (and volume) the strip already passed; the newer local bar is kept for that one bucket.
function mergeLiveBars(analysis){
 const incoming=analysis.bars,local=bars.at(-1),tick=lastLiveTick,compared=incoming.at(-1);
 if(!local||!tick||replayMode||!compared)return incoming;
 const interval=Number(analysis.intervalMs||0);
 const tickAt=Date.parse(tick.timestamp),builtAt=Date.parse(analysis.generatedAt||0);
 if(!(interval>0)||!Number.isFinite(tickAt)||!(tickAt>=builtAt))return incoming;
 if(Math.floor(tickAt/interval)!==Math.floor(compared.timeMs/interval)||local.timeMs!==compared.timeMs)return incoming;
 return [...incoming.slice(0,-1),local];
}
window.addEventListener('market-tick',e=>applyLiveTick(e.detail));
// Footprint settings changed: re-render with the new options. Bars served before the change carry
// the old marks, so drop their cached footprint fields and recompute them from the level maps.
window.addEventListener('gold3po-settings',()=>{for(const b of bars){if(Array.isArray(b.levels)&&b.poc!==undefined){delete b.poc;delete b.valueArea;delete b.imbalances;delete b.stackedImbalances;delete b.absorbedLevels;delete b.unfinishedHigh;delete b.unfinishedLow;delete b.delta;delete b.deltaRatio;delete b.maxLevelVolume;}}renderFootprint();renderInspector();});
window.addEventListener('market-analysis',e=>{if(replayMode)return;const a=e.detail;if(!a?.bars?.length)return;const previousTime=bars[selected]?.time,wasAtLatest=selected===bars.length-1;bars=mergeLiveBars(a);live=true;analysisMeta=a;const tf=Number(a.timeframeMinutes||Number(a.intervalMs)/60000);document.querySelectorAll('.timeframe-label').forEach(node=>{if(Number.isFinite(tf)&&tf>0){const caption=tf>=60?(tf%60===0?tf/60+'ч':tf+'м'):tf+'м';node.textContent=caption+(node.classList.contains('footprint-timeframe')?' · ЕДИНЫЙ ТФ':' · ТИКИ БРОКЕРА');}});zones=a.zones||[];selected=wasAtLatest||selected<0?bars.length-1:Math.max(0,bars.findIndex(b=>b.time===previousTime));levels=currentLevels();const feedLive=a.feed?.status==='online';const status=$('#chartStatus');if(status){status.textContent=(feedLive?'ОНЛАЙН · ':'ИСТОРИЯ · ')+barsWord(bars.length);status.className=feedLive?'ok':'warning';}const signalSummary=$('#signalSummary');if(signalSummary){const sweeps=bars.reduce((n,b)=>n+(b.sweeps?.length||0),0),stacked=bars.reduce((n,b)=>n+(b.stackedImbalances?.length||0),0),absorption=bars.filter(b=>b.absorption).length,exhaustion=bars.filter(b=>b.exhaustion).length,unfinished=bars.filter(b=>b.unfinishedHigh||b.unfinishedLow).length,absorbed=bars.reduce((n,b)=>n+((b.absorbedLevels||[]).length?1:0),0);const naked=a.profile?.naked?.length||0,div=a.divergence?.side;signalSummary.textContent='СНЯТИЯ '+sweeps+' · СТЕКИ '+stacked+' · ПОГЛОЩЕНИЕ УРОВНЕЙ '+absorbed+' · НЕЗАКРЫТЫЕ АУКЦИОНЫ '+unfinished+(naked?' · ГОЛЫХ POC '+naked:'')+(div?(div==='bearish'?' · ДИВЕРГЕНЦИЯ: МЕДВЕЖЬЯ':' · ДИВЕРГЕНЦИЯ: БЫЧЬЯ'):'');}const tag=$('#dataMode');if(tag)tag.textContent=feedLive?'ROBOFOREX MT5 · ОНЛАЙН':'ROBOFOREX MT5 · ИСТОРИЯ';const range=$('#barCount');if(range)range.textContent=barsWord(bars.length);const windowNode=$('#sessionWindow');if(windowNode){const hh=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'':String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');};windowNode.textContent=hh(bars[0].time)+' — '+hh(bars.at(-1).time);}renderZones();select(selected);});
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
window.addEventListener('market-feed-clear',()=>{
 bars=[];zones=[];selected=-1;selectedZone=null;levels=[];analysisMeta=null;live=false;replayMode=false;hasAutoScrolled=false;chartRange=null;
 grid.dataset.autoScroll='1';
 const count=$('#barCount');if(count)count.textContent='ОЖИДАНИЕ ИСТОРИИ';
 const range=$('#sessionRange');if(range)range.textContent='Ожидание истории';
 const status=$('#chartStatus');if(status){status.textContent='ОЖИДАНИЕ ДАННЫХ · ПОДКЛЮЧИТЕ MT5';status.className='warning';}
 renderZones();renderInspector();renderChart();renderFootprint();
});
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
for(const id of ['chartRefresh','footRefresh'])$('#'+id)?.addEventListener('click',async e=>{const btn=e.currentTarget;btn.classList.remove('spin');void btn.offsetWidth;btn.classList.add('spin');try{await window.gold3poRefresh?.();}finally{window.setTimeout(()=>btn.classList.remove('spin'),800);}});
