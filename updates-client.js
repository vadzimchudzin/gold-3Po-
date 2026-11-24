// Checks the published release once per launch and offers it in the top bar. Nothing downloads until
// the operator clicks, a failed check stays silent — an update prompt must never become noise.
const badge = document.getElementById('updateBadge');
const label = document.getElementById('updateVersion');
let offered = null;

function show(text, title) {
  if (!badge || !label) return;
  label.textContent = text;
  badge.title = title;
  badge.hidden = false;
}

async function check() {
  if (!window.goldUpdates?.check) return;
  let result;
  try { result = await window.goldUpdates.check(); } catch { return; }
  if (result?.state !== 'available') return;
  offered = result;
  show(result.version.replace(/^v/, ''), `Доступна версия ${result.version}. Нажмите, чтобы загрузить и установить. Приложение перезапустится само.`);
}

badge?.addEventListener('click', async () => {
  if (!offered || badge.disabled) return;
  badge.disabled = true;
  show('загрузка…', 'Загружаем установщик обновления.');
  let result;
  try { result = await window.goldUpdates.apply(); }
  catch (error) { result = { state: 'error', message: String(error?.message || error) }; }
  if (result?.state === 'installing') { show('установка…', 'Установщик запущен, приложение перезапустится.'); return; }
  badge.disabled = false;
  show(offered.version.replace(/^v/, ''), result?.message || 'Не удалось обновить. Попробуйте позже.');
});

// Late enough not to compete with the first paint and the terminal connection.
setTimeout(check, 5000);
