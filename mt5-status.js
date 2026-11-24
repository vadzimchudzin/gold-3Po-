// The footprint's source precision as the MT5 panel states it: the broker tick size, or why MT5 did
// not give one, in which case footprint rows fall back to the 0.1 step.
const TICK_SIZE_ISSUES = {
  symbol_info_failed: 'запрос спецификации инструмента не выполнен',
  symbol_info_empty: 'спецификация инструмента пуста',
  tick_size_unusable: 'шаг цены в спецификации непригоден',
  not_reported: 'терминал не сообщил шаг цены'
};

export function tickSizeNote(status) {
  if (Number.isFinite(status?.tickSize) && status.tickSize > 0) return ` Шаг цены брокера: ${status.tickSize}.`;
  if (typeof status?.tickSizeIssue === 'string' && status.tickSizeIssue) {
    return ` Шаг цены брокера неизвестен (${TICK_SIZE_ISSUES[status.tickSizeIssue] || 'причина не указана'}), футпринт строится с шагом 0.1.`;
  }
  return '';
}
