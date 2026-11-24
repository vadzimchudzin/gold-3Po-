import { marketSymbol } from './mt5-client.js';
const tfMs = () => window.gold3poIntervalMs?.() || 900000;
const $ = id => document.getElementById(id);
const status = $('researchStatus');
let replayBars = [];
let replayTimer = null;
let latestSignalId = '';
let notificationsEnabled = false;
let signalTimer = null;
// Pattern memory: the search runs on demand, and the threshold slider retunes what counts as similar.
let patternTimer = null;

const patternThreshold = () => Math.max(0.5, Math.min(1, (Number($('patternThreshold')?.value) || 80) / 100));
const patternThresholdLabel = () => { const v = $('patternThresholdValue'); if (v) v.textContent = Math.round(patternThreshold() * 100) + '%'; };

async function refreshPatterns() {
  const result = $('patternResult'), meta = $('patternMeta'), list = $('patternAnalogues');
  if (!result) return;
  try {
    const response = await fetch('/v1/patterns/analogues?symbol=' + encodeURIComponent(marketSymbol()) + '&intervalMs=' + tfMs() + '&threshold=' + patternThreshold(), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data, 'Поиск аналогов не выполнен'));
    if (!data.reference) {
      result.textContent = 'В текущей истории нет подходящего снятия ликвидности, с чем можно сравнивать.';
      meta.textContent = data.message || 'Аналоги — исторические наблюдения похожих сетапов, а не прогноз.';
      list.innerHTML = '';
      return;
    }
    if (!data.count) {
      result.textContent = `Память: ${data.memory} наблюдений. Ни одно не похоже на текущий сетап при пороге ${Math.round(patternThreshold() * 100)}% — ослабьте порог, чтобы увидеть дальше.`;
      meta.textContent = 'Аналоги — исторические наблюдения похожих сетапов, а не прогноз.';
      list.innerHTML = '';
      return;
    }
    const winRate = data.calibrated ? `винрейт ${(data.winRate * 100).toFixed(1)}%` : 'винрейт не показывается: меньше 30 случаев';
    result.textContent = `Похожих случаев: ${data.count} · ${winRate} · матожидание ${data.expectancyR === null ? '—' : (data.expectancyR > 0 ? '+' : '') + data.expectancyR.toFixed(2) + 'R'} · из них вне выборки ${data.outOfSample}`;
    meta.textContent = data.caveat || 'Аналоги — исторические наблюдения похожих сетапов, а не прогноз.';
    const rows = (data.analogues || []).slice(0, 5).map(a => {
      const outcome = a.netR > 0 ? `+${a.netR.toFixed(2)}R` : `${a.netR.toFixed(2)}R`;
      return `<div class="pattern-row"><span>${new Date(a.signalTime).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><b>${Math.round(a.score * 100)}%</b><span class="${a.netR > 0 ? 'win' : 'loss'}">${outcome} · ${exitText(a.exitReason)}</span></div>`;
    });
    list.innerHTML = rows.join('');
    result.classList.toggle('thin', !data.calibrated);
  } catch (error) {
    result.textContent = 'Поиск аналогов не выполнен: ' + error.message;
  }
}

const number = (id, fallback) => {
  const value = Number($(id)?.value);
  return Number.isFinite(value) ? value : fallback;
};
const localInput = date => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0,16);
};
const money = value => Number(value).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
const sideText = side => side === 'long' ? 'ЛОНГ' : side === 'short' ? 'ШОРТ' : String(side || '').toUpperCase();
const exitText = reason => ({target:'тейк',stop:'стоп',time:'по времени'})[reason] || String(reason || '');
const calibrationText = status => ({insufficient_out_of_sample_samples:'недостаточно истории',walk_forward_historical_win_rate:'винрейт по истории'})[status] || String(status || '');
const notify = message => {
  if (status) status.textContent = message;
};
const apiError = (data, fallback) => data?.error === 'license_required'
  ? 'Требуется лицензия — активируйте ключ на экране лицензии.'
  : (data?.message || data?.error || fallback);

function stopReplay() {
  if (replayTimer !== null) window.clearInterval(replayTimer);
  replayTimer = null;
  if ($('playReplay')) $('playReplay').disabled = replayBars.length === 0;
  if ($('pauseReplay')) $('pauseReplay').disabled = true;
}
async function exitReplay() {
  stopReplay();
  replayBars = [];
  $('playReplay').disabled = true;
  $('replaySlider').disabled = true;
  $('liveView').disabled = true;
  $('replayPosition').textContent = 'Живой рынок';
  window.dispatchEvent(new CustomEvent('exit-replay'));
  try {
    const response = await fetch('/v1/market/analysis?symbol='+encodeURIComponent(marketSymbol())+'&intervalMs='+tfMs()+'&priceStep=0.1',{cache:'no-store'});
    const data = await response.json();
    if (!response.ok) { notify(apiError(data,'Не удалось обновить живые данные')); return; }
    if (data.bars?.length) window.dispatchEvent(new CustomEvent('market-analysis',{detail:data}));
    notify('Вернулись к текущему фиду брокера.');
  } catch(error) { notify('Не удалось обновить живые данные: '+error.message); }
}
function selectReplay(index) {
  if (!replayBars.length) return;
  const safe = Math.max(0,Math.min(replayBars.length-1,Number(index)||0));
  $('replaySlider').value = String(safe);
  $('replayPosition').textContent = `${safe+1} / ${replayBars.length} · ${new Date(replayBars[safe].time).toLocaleString('ru-RU')}`;
  window.dispatchEvent(new CustomEvent('market-replay-step',{detail:{index:safe}}));
}
async function loadReplay() {
  replayBars = [];
  stopReplay();
  $('replaySlider').disabled = true;
  $('liveView').disabled = true;
  notify('Загружаем исторические тики и строим свечи повтора…');
  const from = $('replayFrom').value, to = $('replayTo').value;
  const query = new URLSearchParams({symbol:marketSymbol(),intervalMs:String(tfMs()),priceStep:'0.1'});
  if (from) query.set('from',new Date(from).toISOString());
  // Пока поле «По» не меняли, оно означает «до текущего момента», поэтому новые тики тоже попадают в повтор.
  if (to && to !== autoReplayTo) query.set('to',new Date(to).toISOString());
  try {
    const response = await fetch('/v1/market/replay?'+query.toString(),{cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data,'Запрос повтора не выполнен'));
    replayBars = data.bars || [];
    if (!replayBars.length) {
      $('replaySlider').disabled = true;
      $('playReplay').disabled = true;
      $('pauseReplay').disabled = true;
      $('replayPosition').textContent = 'В выбранном периоде нет свечей';
      notify(`Тики брокера не найдены. Событий: ${data.eventCount || 0}`);
      return;
    }
    $('replaySlider').min='0';
    $('replaySlider').max=String(replayBars.length-1);
    $('replaySlider').step='1';
    $('replaySlider').disabled=false;
    $('playReplay').disabled=false;
    $('pauseReplay').disabled=true;
    $('liveView').disabled=false;
    window.dispatchEvent(new CustomEvent('market-replay',{detail:data}));
    selectReplay(0);
    notify(`Повтор готов: ${replayBars.length} свечей из ${data.eventCount} тиков`);
  } catch(error) { notify('Ошибка повтора: '+error.message); }
}
function playReplay() {
  if (!replayBars.length || replayTimer !== null) return;
  const speed = Math.max(0.25,Number($('replaySpeed').value)||1);
  $('playReplay').disabled=true;
  $('pauseReplay').disabled=false;
  replayTimer = window.setInterval(()=>{
    const next = Number($('replaySlider').value)+1;
    if (next >= replayBars.length) { stopReplay(); return; }
    selectReplay(next);
  },Math.max(60,500/speed));
}
async function runBacktest() {
  notify('Идёт историческая симуляция…');
  const query = new URLSearchParams({
    symbol:marketSymbol(),intervalMs:String(tfMs()),initialEquity:String(number('backtestEquity',10000)),
    riskPct:String(number('backtestRisk',0.5)),
    pointValue:String(number('backtestPointValue',1))
  });
  try {
    const response = await fetch('/v1/market/backtest?'+query.toString(),{cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data,'Бэктест не выполнен'));
    const s = data.summary;
    $('backtestSummary').textContent = `${s.trades} сделок · ${s.wins} прибыльных / ${s.losses} убыточных · винрейт ${s.winRate===null?'—':(s.winRate*100).toFixed(1)+'%'} · P&L ${s.netPnl>=0?'+':''}${money(s.netPnl)} · макс. просадка ${s.maxDrawdownPct.toFixed(2)}%`;
    $('backtestDetails').textContent = s.trades
      ? `Итоговый капитал ${money(s.finalEquity)} · профит-фактор ${s.profitFactor===null?'∞':s.profitFactor.toFixed(2)} · матожидание ${s.expectancyR.toFixed(3)}R · средняя прибыль ${s.avgWin===null?'—':money(s.avgWin)} · средний убыток ${s.avgLoss===null?'—':money(s.avgLoss)} · комиссии ${money(s.totalFees)} · проскальзывание ${money(s.slippageCost)} · свечей: ${data.bars}${s.periodStart?` · период ${new Date(s.periodStart).toLocaleDateString('ru-RU')} — ${new Date(s.periodEnd).toLocaleDateString('ru-RU')}`:''}`
      : `Подходящих сетапов нет среди ${data.bars} доступных свечей. Нужны прогрев и корректные снятия ликвидности.`;
    $('backtestCaveat').textContent = data.limitations.join(' ');
    const rows = (data.trades||[]).slice(-8).reverse().map(t=>`${sideText(t.side)} · ${new Date(t.entryTime).toLocaleString('ru-RU')} → ${new Date(t.exitTime).toLocaleString('ru-RU')} · ${exitText(t.exitReason)} · ${t.netR.toFixed(2)}R`);
    $('backtestTrades').textContent = rows.length ? rows.join(' | ') : 'Закрытых сделок пока нет.';
    notify('Бэктест завершён. Исторические результаты не являются прогнозом.');
  } catch(error) { notify('Ошибка бэктеста: '+error.message); }
}
async function calculateRisk() {
  notify('Считаем объём позиции и лимиты риска…');
  const query = new URLSearchParams({
    equity:String(number('riskEquity',10000)),riskPct:String(number('riskPercent',0.5)),
    entry:String(number('riskEntry',2650)),stop:String(number('riskStop',2645)),
    target:String(number('riskTarget',2660)),pointValue:String(number('riskPointValue',1)),
    maxRiskPct:'1',minRiskReward:'1.5'
  });
  try {
    const response = await fetch('/v1/risk/plan?'+query.toString(),{cache:'no-store'});
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data,'Расчёт риска не выполнен'));
    $('riskResult').textContent = `${data.allowed?'ПЛАН ПРОХОДИТ ПРОВЕРКУ':'ПЛАН ЗАБЛОКИРОВАН'} · ${data.direction?sideText(data.direction):'НАПРАВЛЕНИЕ НЕ ОПРЕДЕЛЕНО'} · объём ${Number(data.quantity.toFixed(4)).toLocaleString('ru-RU',{maximumFractionDigits:4})} ед. · плановый убыток ${money(data.plannedLoss)} · целевая прибыль ${money(data.plannedGain)} · R:R ${money(data.riskReward)}:1`;
    $('riskChecks').textContent = data.checks.map(item=>(item.passed?'ОК':'БЛОК')+' — '+item.message).join(' · ');
    notify(data.allowed?'План риска в пределах заданных лимитов.':'План риска заблокирован ограничителями.');
  } catch(error) { notify('Ошибка расчёта риска: '+error.message); }
}
async function refreshSignals() {
  try {
    const response = await fetch('/v1/market/signals?symbol='+encodeURIComponent(marketSymbol())+'&intervalMs='+tfMs(),{cache:'no-store'});
    if (!response.ok) return;
    const data = await response.json();
    const signal = data.latest;
    if (!signal) {
      $('signalMonitor').textContent = 'В текущей истории нет подходящего снятия ликвидности.';
      $('signalCalibration').textContent = data.caveat || '';
      return;
    }
    const probability = signal.probability === null ? 'без калибровки' : (signal.probability*100).toFixed(1)+'% исторический винрейт';
    $('signalMonitor').textContent = `${sideText(signal.side)} · техническая оценка ${(signal.technicalScore*100).toFixed(0)}/100 · ${probability} · ${new Date(signal.time).toLocaleString('ru-RU')}`;
    $('signalCalibration').textContent = signal.evidence.join(' · ')+' | '+calibrationText(signal.calibrationStatus)+' ('+(signal.calibrationSamples||0)+' прошлых сделок)';
    if (notificationsEnabled && signal.id !== latestSignalId && signal.technicalScore >= 0.70 && 'Notification' in window) {
      new Notification('GOLD-3Po · '+sideText(signal.side),{body:`Сетап снятия ликвидности. Техническая оценка ${(signal.technicalScore*100).toFixed(0)}/100. Это не торговая рекомендация.`});
    }
    latestSignalId = signal.id;
  } catch {}
}
$('loadReplay')?.addEventListener('click',loadReplay);
$('findAnalogues')?.addEventListener('click',()=>{refreshPatterns();});
$('patternThreshold')?.addEventListener('input',()=>{patternThresholdLabel();if(patternTimer!==null)window.clearTimeout(patternTimer);patternTimer=window.setTimeout(()=>{patternTimer=null;refreshPatterns();},400);});
$('playReplay')?.addEventListener('click',playReplay);
$('pauseReplay')?.addEventListener('click',stopReplay);
$('liveView')?.addEventListener('click',exitReplay);
$('replaySlider')?.addEventListener('input',event=>{stopReplay();selectReplay(event.target.value);});
$('runBacktest')?.addEventListener('click',runBacktest);
$('calculateRisk')?.addEventListener('click',calculateRisk);
$('enableAlerts')?.addEventListener('click',async()=>{
  if (!('Notification' in window)) { notify('Браузерные уведомления не поддерживаются. Сигналы остаются в этой панели.'); return; }
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  notificationsEnabled = permission === 'granted';
  $('enableAlerts').textContent = notificationsEnabled ? 'Уведомления включены' : 'Включить уведомления';
  notify(notificationsEnabled ? 'Уведомления о сигналах включены в этом браузере.' : 'Разрешение на уведомления не выдано.');
});
const end = new Date(), start = new Date(end.getTime()-30*86400000);
if ($('replayFrom')) $('replayFrom').value = localInput(start);
if ($('replayTo')) $('replayTo').value = localInput(end);
const autoReplayTo = $('replayTo')?.value || '';
window.addEventListener('market-analysis',()=>{
  if (signalTimer !== null) window.clearTimeout(signalTimer);
  signalTimer = window.setTimeout(()=>{signalTimer=null;refreshSignals();},1800);
  if (patternTimer !== null) window.clearTimeout(patternTimer);
  patternTimer = window.setTimeout(()=>{patternTimer=null;refreshPatterns();},2400);
});
window.addEventListener('setups-changed',()=>{refreshSignals();});
window.addEventListener('mt5-symbol-change',()=>{if(replayBars.length)void exitReplay();refreshSignals();refreshPatterns();});
refreshSignals();
refreshPatterns();
