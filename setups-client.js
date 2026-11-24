const $ = id => document.getElementById(id);
const statusNode = $('setupStatus');
let library = null;

function say(message) { if (statusNode) statusNode.textContent = message; }

function fillFields(definition) {
  const s = definition.strategy, b = definition.backtest;
  const setVal = (id, val) => { if ($(id)) $(id).value = val === null || val === undefined ? '' : String(val); };
  const setChk = (id, val) => { if ($(id)) $(id).checked = Boolean(val); };
  setVal('condMinScore', s.minScore);
  setVal('condAtrPeriod', s.atrPeriod);
  setVal('condEntryMode', s.entryMode ?? 'sweep');
  setVal('condTrendFilter', s.trendFilter ?? 'none');
  setVal('condTrendPeriod', s.trendPeriod ?? 20);
  setVal('condCloseEdgeThreshold', s.closeEdgeThreshold ?? 0.65);
  setVal('condMinBodyRatio', s.minBodyRatio ?? 0);
  setVal('condMaxBodyRatio', s.maxBodyRatio ?? 1);
  setVal('condMinWickRatio', s.minWickRatio ?? 0);
  setVal('condMinVolume', s.minVolume ?? 0);
  setVal('condMinDeltaRatio', s.minDeltaRatio ?? 0);
  setVal('condMinAtr', s.minAtr ?? 0);
  setVal('condMaxAtr', s.maxAtr ?? 0);
  setVal('condCooldownBars', s.cooldownBars ?? 0);
  setVal('condWeightRejection', s.weightRejection ?? 0.15);
  setVal('condWeightCloseEdge', s.weightCloseEdge ?? 0.10);
  setVal('condWeightStacked', s.weightStacked ?? 0.15);
  setVal('condWeightDelta', s.weightDelta ?? 0.10);
  setChk('condRejection', s.requireRejection);
  setChk('condCloseEdge', s.requireCloseEdge);
  setChk('condStacked', s.requireStacked);
  setChk('condDelta', s.requireDeltaAgree);
  setChk('condAbsorption', s.requireAbsorption);
  setChk('condExhaustion', s.requireExhaustion);
  setChk('condUnfinished', s.requireUnfinished);
  setVal('condSides', s.allowedSides.length === 2 ? 'both' : s.allowedSides[0]);
  setVal('condSessionFrom', s.sessionHoursUTC ? s.sessionHoursUTC[0] : '');
  setVal('condSessionTo', s.sessionHoursUTC ? s.sessionHoursUTC[1] : '');
  setVal('condStopAtr', b.stopAtr);
  setVal('condTargetR', b.targetR);
  setVal('condMaxBars', b.maxBars);
  setVal('condRiskPct', b.riskPct);
  setVal('condPointValue', b.pointValue);
  setVal('condBreakevenR', b.breakevenR ?? 0);
  setVal('condTrailingAtr', b.trailingAtr ?? 0);
  setVal('condFeePerUnit', b.feePerUnit ?? 0);
  setVal('condSlippage', b.slippage ?? 0);
}

function collectDefinition() {
  const num = (id, fallback) => { const v = Number($(id)?.value); return Number.isFinite(v) ? v : fallback; };
  const sides = $('condSides')?.value || 'both';
  const from = $('condSessionFrom')?.value, to = $('condSessionTo')?.value;
  const session = (from !== '' && to !== '' && from !== undefined && to !== undefined) ? [Number(from), Number(to)] : null;
  return {
    strategy: {
      minScore: num('condMinScore', 0.55),
      atrPeriod: Math.round(num('condAtrPeriod', 14)),
      entryMode: $('condEntryMode')?.value || 'sweep',
      trendFilter: $('condTrendFilter')?.value || 'none',
      trendPeriod: Math.round(num('condTrendPeriod', 20)),
      closeEdgeThreshold: num('condCloseEdgeThreshold', 0.65),
      minBodyRatio: num('condMinBodyRatio', 0),
      maxBodyRatio: num('condMaxBodyRatio', 1),
      minWickRatio: num('condMinWickRatio', 0),
      minVolume: num('condMinVolume', 0),
      minDeltaRatio: num('condMinDeltaRatio', 0),
      minAtr: num('condMinAtr', 0),
      maxAtr: num('condMaxAtr', 0),
      cooldownBars: Math.round(num('condCooldownBars', 0)),
      weightRejection: num('condWeightRejection', 0.15),
      weightCloseEdge: num('condWeightCloseEdge', 0.10),
      weightStacked: num('condWeightStacked', 0.15),
      weightDelta: num('condWeightDelta', 0.10),
      requireRejection: Boolean($('condRejection')?.checked),
      requireCloseEdge: Boolean($('condCloseEdge')?.checked),
      requireStacked: Boolean($('condStacked')?.checked),
      requireDeltaAgree: Boolean($('condDelta')?.checked),
      requireAbsorption: Boolean($('condAbsorption')?.checked),
      requireExhaustion: Boolean($('condExhaustion')?.checked),
      requireUnfinished: Boolean($('condUnfinished')?.checked),
      allowedSides: sides === 'both' ? ['long', 'short'] : [sides],
      sessionHoursUTC: session
    },
    backtest: {
      stopAtr: num('condStopAtr', 1.5),
      targetR: num('condTargetR', 2),
      maxBars: Math.round(num('condMaxBars', 20)),
      riskPct: num('condRiskPct', 0.5),
      pointValue: num('condPointValue', 1),
      breakevenR: num('condBreakevenR', 0),
      trailingAtr: num('condTrailingAtr', 0),
      feePerUnit: num('condFeePerUnit', 0),
      slippage: num('condSlippage', 0)
    }
  };
}

function renderLibrary() {
  const select = $('setupSelect');
  if (!select || !library) return;
  const previous = select.value;
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Условия по умолчанию (сетап не применён)';
  select.appendChild(none);
  for (const setup of library.setups) {
    for (const version of setup.versions) {
      const option = document.createElement('option');
      option.value = setup.id + '|' + version.version;
      option.textContent = setup.name + ' · v' + version.version + ' · ' + version.fingerprint.slice(0, 8);
      select.appendChild(option);
    }
  }
  if (library.activeId) select.value = library.activeId + '|' + library.activeVersion;
  else if ([...select.options].some(o => o.value === previous)) select.value = previous;
  fillFields(library.activeDefinition);
  const active = library.setups.find(s => s.id === library.activeId);
  say(active ? 'Активен: ' + active.name + ' · v' + library.activeVersion + '. Сохранённые версии неизменяемы; повторное сохранение добавит новую версию.' : 'Активны условия по умолчанию. Сохраните свои условия как именованный сетап.');
}

async function loadLibrary() {
  try {
    const response = await fetch('/v1/setups', { cache: 'no-store' });
    if (response.status === 402) { say('Требуется лицензия — активируйте ключ, чтобы работать с сетапами.'); return; }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    library = await response.json();
    renderLibrary();
  } catch (error) { say('Библиотека сетапов недоступна: ' + error.message); }
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || 'HTTP ' + response.status);
  return data;
}

function announceChange() { window.dispatchEvent(new CustomEvent('setups-changed')); }

$('saveSetup')?.addEventListener('click', async () => {
  const name = ($('setupName')?.value || '').trim();
  if (!name) { say('Сначала введите название сетапа.'); return; }
  try {
    const result = await postJson('/v1/setups', { name, definition: collectDefinition() });
    await loadLibrary();
    say(result.deduplicated ? 'Такие условия уже сохранены как ' + name + ' v' + result.version + '.' : 'Сохранено: ' + name + ' v' + result.version + ' (' + result.fingerprint.slice(0, 8) + '). Нажмите «Применить», чтобы использовать.');
    announceChange();
  } catch (error) { say('Не удалось сохранить: ' + error.message); }
});

$('applySetup')?.addEventListener('click', async () => {
  const value = $('setupSelect')?.value;
  if (!value) { say('Выберите сохранённую версию сетапа, чтобы применить.'); return; }
  const [id, version] = value.split('|');
  try {
    await postJson('/v1/setups/apply', { id, version: Number(version) });
    await loadLibrary();
    say('Применено. Сигналы, бэктест и риск теперь используют эти условия.');
    announceChange();
  } catch (error) { say('Не удалось применить: ' + error.message); }
});

$('exportSetup')?.addEventListener('click', async () => {
  const value = $('setupSelect')?.value;
  if (!value) { say('Выберите версию сетапа для экспорта.'); return; }
  const [id, version] = value.split('|');
  try {
    const response = await fetch('/v1/setups/export?id=' + encodeURIComponent(id) + '&version=' + version, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'gold3po-setup-' + data.name.replace(/[^\w.-]+/g, '-') + '-v' + data.version + '.json';
    link.click();
    URL.revokeObjectURL(link.href);
    say('Экспортировано: ' + data.name + ' v' + data.version + ' в JSON.');
  } catch (error) { say('Не удалось экспортировать: ' + error.message); }
});

$('importSetup')?.addEventListener('click', () => $('importSetupFile')?.click());

$('importSetupFile')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const definition = parsed.definition || parsed;
    const name = parsed.name || file.name.replace(/\.json$/i, '');
    const result = await postJson('/v1/setups/import', { name, definition });
    await loadLibrary();
    say('Импортировано как новый сетап (v' + result.version + '). Примените его вручную, когда будете готовы.');
    announceChange();
  } catch (error) { say('Импорт отклонён: ' + error.message); }
  event.target.value = '';
});

const PRESETS = {
  base: {
    name: 'Снятие ликвидности (базовая)',
    strategy: { minScore: 0.55, atrPeriod: 14, entryMode: 'sweep', trendFilter: 'none', trendPeriod: 20, closeEdgeThreshold: 0.65, minBodyRatio: 0, maxBodyRatio: 1, minWickRatio: 0, minVolume: 0, minDeltaRatio: 0, minAtr: 0, maxAtr: 0, cooldownBars: 0, weightRejection: 0.15, weightCloseEdge: 0.10, weightStacked: 0.15, weightDelta: 0.10, requireRejection: false, requireCloseEdge: false, requireStacked: false, requireDeltaAgree: false, requireAbsorption: false, requireExhaustion: false, requireUnfinished: false, allowedSides: ['long', 'short'], sessionHoursUTC: null },
    backtest: { stopAtr: 1.5, targetR: 2, maxBars: 20, riskPct: 0.5, pointValue: 1, breakevenR: 0, trailingAtr: 0, feePerUnit: 0, slippage: 0 }
  },
  pinbar: {
    name: 'Пин-бар + дельта (разворот)',
    strategy: { minScore: 0.6, atrPeriod: 14, entryMode: 'sweep', trendFilter: 'none', trendPeriod: 20, closeEdgeThreshold: 0.7, minBodyRatio: 0, maxBodyRatio: 0.45, minWickRatio: 0.45, minVolume: 0, minDeltaRatio: 0.15, minAtr: 0, maxAtr: 0, cooldownBars: 2, weightRejection: 0.20, weightCloseEdge: 0.15, weightStacked: 0.10, weightDelta: 0.15, requireRejection: true, requireCloseEdge: true, requireStacked: false, requireDeltaAgree: true, requireAbsorption: false, requireExhaustion: false, requireUnfinished: false, allowedSides: ['long', 'short'], sessionHoursUTC: [7, 20] },
    backtest: { stopAtr: 1.2, targetR: 2.5, maxBars: 24, riskPct: 0.5, pointValue: 1, breakevenR: 1, trailingAtr: 0, feePerUnit: 0, slippage: 0 }
  },
  imbalance: {
    name: 'Стек имбалансов по тренду',
    strategy: { minScore: 0.55, atrPeriod: 14, entryMode: 'imbalance', trendFilter: 'with', trendPeriod: 20, closeEdgeThreshold: 0.65, minBodyRatio: 0.35, maxBodyRatio: 1, minWickRatio: 0, minVolume: 0, minDeltaRatio: 0.25, minAtr: 0, maxAtr: 0, cooldownBars: 3, weightRejection: 0.10, weightCloseEdge: 0.10, weightStacked: 0.25, weightDelta: 0.15, requireRejection: true, requireCloseEdge: false, requireStacked: true, requireDeltaAgree: true, requireAbsorption: false, requireExhaustion: false, requireUnfinished: false, allowedSides: ['long', 'short'], sessionHoursUTC: null },
    backtest: { stopAtr: 1.5, targetR: 3, maxBars: 30, riskPct: 0.5, pointValue: 1, breakevenR: 1, trailingAtr: 1.2, feePerUnit: 0, slippage: 0 }
  },
  absorption: {
    name: 'Поглощение против толпы',
    strategy: { minScore: 0.55, atrPeriod: 14, entryMode: 'absorption', trendFilter: 'counter', trendPeriod: 20, closeEdgeThreshold: 0.6, minBodyRatio: 0, maxBodyRatio: 1, minWickRatio: 0.25, minVolume: 0, minDeltaRatio: 0, minAtr: 0, maxAtr: 0, cooldownBars: 2, weightRejection: 0.15, weightCloseEdge: 0.10, weightStacked: 0.15, weightDelta: 0.10, requireRejection: false, requireCloseEdge: false, requireStacked: false, requireDeltaAgree: false, requireAbsorption: true, requireExhaustion: false, requireUnfinished: false, allowedSides: ['long', 'short'], sessionHoursUTC: null },
    backtest: { stopAtr: 1.4, targetR: 2.5, maxBars: 25, riskPct: 0.5, pointValue: 1, breakevenR: 1.2, trailingAtr: 0, feePerUnit: 0, slippage: 0 }
  }
};

$('setupPresets')?.addEventListener('click', event => {
  const button = event.target.closest('button[data-preset]');
  if (!button) return;
  const preset = PRESETS[button.dataset.preset];
  if (!preset) return;
  fillFields(preset);
  if ($('setupName') && !$('setupName').value.trim()) $('setupName').value = preset.name;
  say('Подставлен шаблон «' + preset.name + '». Подкрутите любые параметры и нажмите «Сохранить версию».');
});

loadLibrary();
