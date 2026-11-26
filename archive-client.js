// The tick archive for the footprint, downloaded on request by the desktop MT5 bridge, and the state
// of the broker's candles. Without the desktop bridge (a plain browser) there is nothing to download.
const $ = id => document.getElementById(id);
const bridge = window.goldMt5;
let busy = false, last = null;

const plural = (n, one, few, many) => { const t = n % 100, o = n % 10; return n + ' ' + (o === 1 && t !== 11 ? one : o >= 2 && o <= 4 && (t < 12 || t > 14) ? few : many); };

function render(status) {
  last = status;
  const online = status?.state === 'online';
  const archive = status?.archive || null;
  const running = archive?.state === 'running';
  if ($('archiveStart')) $('archiveStart').disabled = !bridge || !online || busy || running;
  if ($('archiveStop')) $('archiveStop').disabled = !bridge || !running;
  if ($('archiveDays')) $('archiveDays').disabled = running;
  const share = archive && archive.total ? archive.done / archive.total : 0;
  const bar = $('archiveBar');
  if (bar) { bar.style.width = Math.round(share * 100) + '%'; bar.parentElement.classList.toggle('is-running', running); }
  const node = $('archiveStatus');
  if (node) {
    if (!bridge) node.textContent = 'Загрузка истории доступна в настольной версии для Windows.';
    else if (!online) node.textContent = 'Подключите MT5, чтобы скачать историю.';
    else if (!archive) node.textContent = 'Тики за последние 2 часа подгружаются автоматически. Нужна более глубокая история — выберите глубину и нажмите «Скачать тики».';
    else {
      const days = plural(archive.days, 'день', 'дня', 'дней');
      const got = archive.ticks ? ` · получено ${archive.ticks.toLocaleString('ru-RU')} тиков` : '';
      const had = archive.already ? ` · ${archive.already} окон уже были в архиве` : '';
      const skipped = archive.skipped ? ` · пропущено ${archive.skipped} (MT5 не отдал)` : '';
      node.textContent = archive.state === 'running' ? `Загрузка за ${days}: ${Math.round(share * 100)}%${got}${had}${skipped}. Живой поток не ждёт.`
        : archive.state === 'done' ? `История за ${days} загружена${got}${had}${skipped}. Футпринт дорисован на этих свечах.`
        : `Загрузка остановлена на ${Math.round(share * 100)}%${got}. Уже скачанное сохранено.`;
    }
  }
  const candles = status?.candles;
  const info = $('candlesInfo');
  if (info) info.textContent = !online ? 'Свечи MT5: ожидание подключения.'
    : candles?.loaded ? `Свечи MT5: ${plural(candles.days, 'день', 'дня', 'дней')} минутной истории (${(candles.count || 0).toLocaleString('ru-RU')} баров), обновляются каждые 15 секунд.`
    : 'Свечи MT5: загружаются…';
  const chip = $('candleStatus');
  if (chip) { chip.textContent = !online ? 'ОЖИДАНИЕ' : candles?.loaded ? 'ЗАГРУЖЕНЫ · ' + candles.days + ' ДН.' : 'ЗАГРУЗКА'; chip.className = candles?.loaded && online ? 'ok' : 'warning'; }
}

async function run(request) {
  if (!bridge?.archive || busy) return;
  busy = true; render(last);
  try { render(await bridge.archive(request)); }
  catch (error) { const node = $('archiveStatus'); if (node) node.textContent = error?.message || 'Не удалось запустить загрузку.'; }
  finally { busy = false; render(last); }
}

$('archiveStart')?.addEventListener('click', () => run({ days: Number($('archiveDays')?.value) || 3 }));
$('archiveStop')?.addEventListener('click', () => run({ stop: true }));
window.addEventListener('mt5-status', e => render(e.detail));
render(null);
