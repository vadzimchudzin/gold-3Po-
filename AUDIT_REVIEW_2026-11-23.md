# GOLD-3Po — аудит PR #1 и список задач для исправления

Дата аудита: 2026-11-23  
Репозиторий: `ORSP-w/gold-3Po-`  
PR: https://github.com/ORSP-w/gold-3Po-/pull/1  
CI run: https://github.com/ORSP-w/gold-3Po-/actions/runs/45225328286  
Merge commit: `719ce96f605b81e1bf21e059ea90bffc688a2a1d`

> **Статус:** PR #1 слит в организационный `main` по прямому запросу владельца, несмотря на красный CI и незавершённые пункты ТЗ. Это не означает, что аудит пройден или все замечания подтверждены. Этот документ — рабочий backlog для отдельного агента. Исправления делать отдельными коммитами/PR, не переписывать историю merge-коммита.

## 1. Обязательные блокеры CI

Последний проверенный workflow run: **230 passed / 2 failed**. Из-за fail-fast следующие шаги, включая `npm run check` и browser check, в этом запуске не выполнились.

### CI-1. Сигнал stacked imbalance не формируется с настройками по умолчанию
- Файл: `server.test.js`, тест около строки 281, assertion около 292.
- Тест: `imbalanceLevels setting changes what the strategy sees in the signals route`.
- Ошибка: `the default settings keep the stacked signal, got 0`.
- Смысл: тест ожидает stacked signal при default settings, но endpoint вернул 0.
- Проверить отдельно: корректность fixture/candles; передачу `imbalanceLevels` из настроек в стратегию; расчёт imbalance/stack; преобразование результата в signals route.
- Не подгонять тест под фактический ноль без выяснения, должен ли этот fixture действительно давать сигнал.
- Добавить проверку, что изменение `imbalanceLevels` меняет результат стратегии на валидном fixture.

### CI-2. Fixture не создаёт reference signal для проверки analogue cache
- Файл: `server.test.js`, тест около строки 417, assertion около 422.
- Тест: `a settings change invalidates the analogue cache, not just new events`.
- Ошибка: `the fixture must yield a reference signal`.
- Смысл: тест не получил исходный reference signal, поэтому проверка инвалидации cache фактически не состоялась.
- Проверить fixture, условия генерации reference signal и настройки/временные границы теста.
- После исправления тест должен сначала явно подтвердить наличие reference signal, затем изменить настройки и доказать, что cache пересчитан, а не возвращает старый результат.

## 2. Все 32 незакрытых review threads

Ниже сохранены все замечания из PR review. **Outdated** означает, что комментарий привязан к устаревшей версии строки/диффа; это не доказывает, что проблема исправлена. Перед изменением агент обязан проверить текущий `main`. Комментарии с ответом автора отмечены отдельно.

### Логика зон и footprint

1. **[Актуальное замечание] `zone-reaction.js:47` — horizon для длинного touch-run.**  
   Сканирование начинается с первой свечи серии касания (`k = i`), но horizon может отсчитываться от конца серии. Длинная серия способна расширить фактическое look-ahead за пределы заданного `horizon` и завысить respected/broken counts. Проверить семантику horizon и ограничить окно либо явно считать его от конца серии. Добавить тест на длинную серию.

2. **[Актуальное замечание] `zone-sources.test.js:69` — нет проверки formedAt.**  
   Тест проверяет `level.index`, но не подтверждает, что `formedAt` равен времени свечи-источника (например, Prior day high). Добавить assertion на `bars[level.index].time` и проверить путь `market-engine.js`.

3. **[Актуальное замечание] `footprint-engine.js:224` — несопоставимые величины в absorption threshold.**  
   Агрессивный объём сравнивается с медианой `row.total` (bid + ask + unknown). При большом объёме неизвестной стороны порог искусственно растёт, хотя unknown не участвует в aggressive volume. Проверить и, если замечание подтверждается, считать медиану по `row.bid + row.ask`. Добавить тест с большим unknown volume.

4. **[Актуальное замечание] `footprint-engine.test.js:78` — тест inferred step не изолирует проверяемый случай.**  
   Текущие цены 104 / 103.5 / 102 дают минимальный шаг 0.5, поэтому тест мог бы пройти и при неверном inferred step = 1. Добавить случай, где inferred step действительно определяет соседство (например, 104 / 103 / 101 без явного priceStep), и проверить пары 104↔103 и 103↔101.

5. **[Оспорено автором; не считать подтверждённым дефектом] `footprint-engine.js:224` — medianLevelVolume выглядит неиспользуемым.**  
   Review предлагает удалить вычисление/поле, но автор указал, что это существующая часть публичного результата `footprintOf`, которую `app.js` распространяет через объект бара. Сохранять совместимость результата. Не удалять поле без проверки API-контракта и потребителей.

6. **[Требует решения по продуктовой семантике] `footprint-engine.js:150` — ticksPerRow влияет на сигналы, а не только на отображение.**  
   Группировка применяется до imbalance, absorption и value area, поэтому меняет математику сигналов и backtest. Это расходится с формулировкой, будто настройка только визуальная. Зафиксировать ожидаемое поведение: либо прямо документировать влияние на signal math/backtest и UI hint, либо отделить display grouping от расчёта marks. Добавить тесты на выбранный контракт.

7. **[Outdated] `market-engine.js` — профиль мог остаться на исходной сетке.**  
   Review утверждал, что `sessionProfile` и browser profile использовали 0.1, тогда как footprint группировал строки. Проверить текущий код после последующих изменений: POC, value area и profile rows должны соответствовать выбранному row step, если таков утверждённый контракт. Не применять старый diff вслепую.

8. **[Актуальное замечание] `ui.browser.mjs:254` — browser test может не доказывать локальную группировку.**  
   Server refetch может сам вернуть сгруппированные данные, поэтому тест не обязательно проверяет локальный `barFootprint` path. Добавить assertion, который доказывает именно локальную группировку, например проверку ценовых меток на сетке 0.5 без server refetch.

9. **[Outdated] `footprint-engine.test.js` — тест передаёт результат туда, где production path так не делает.**  
   Проверка повторной подачи результата описывает несуществующий путь: `applyLiveTick` и `barFootprint` передают raw level map. Удалить/заменить тест проверкой реального forming-bar path, если это всё ещё актуально.

10. **[Outdated; автор возразил] `app.js` — двойная группировка forming bar.**  
    Review предполагал, что `applyLiveTick` сохраняет сгруппированные `bar.levels`, а рендер группирует их повторно, что может рассинхронизировать live и closed bars. Автор ответил, что live path пересчитывает из raw `levelMap`, `barFootprint` возвращает готовый bar при наличии POC/valueArea, а тесты проверяют одинаковый результат. Не менять без воспроизведения на текущем коде. Проверить live forming bar против server-computed closed bar на одинаковых данных.

11. **[Outdated] `ui.browser.mjs` — grid assertion может пройти на пустом наборе.**  
    NaN price labels могут быть отфильтрованы так, что проверка не подтверждает ни одной ячейки. Проверить актуальность. При необходимости требовать `Number.isFinite(price)` и равенство количества разобранных цен числу проверяемых ячеек.

12. **[Outdated] `market-engine.test.js` — сравнение профиля и ladder может быть тавтологичным.**  
    Проверка сравнивает профиль с ladder тех же уже сгруппированных bars и может пройти без реального влияния `ticksPerRow`. Проверить, есть ли независимый assertion, который доказывает настройку профиля. Если нет — добавить независимый fixture.

13. **[Outdated] `market-engine.test.js` — value-area test проверяет только рост числа строк.**  
    Рост числа строк не доказывает, что покрытая доля соответствует запрошенной. Проверить текущий тест; при необходимости утверждать фактическую долю для значений, например 0.5 и 0.95.

### Tick size, MT5 и серверное состояние

14. **[Актуальное замечание] `server.js:114` — symbolSpecs не очищается при disconnect/reconnect.**  
    Старый broker tick size может продолжить влиять на footprint, POC, value area и backtest после отключения или подключения к другому брокеру. Проверить lifecycle и добавить очистку/expiry/привязку к сессии, чтобы stale spec не переживал смену broker session.

15. **[Outdated] `server.js` — rememberSpec вызывается до проверки gold symbol.**  
    Review указывал на риск бесконечно добавлять `source:symbol` записи через ingest token. Проверить текущую реализацию: валидация символа должна предшествовать сохранению, а хранилище иметь ограничение/eviction. Учитывать, что замечание помечено outdated.

16. **[Outdated, низкий приоритет] `server.js` — digits передаётся, но не используется.**  
    Проверить весь путь connector/session/server и потребителей. Если digits не нужен — удалить из контракта; если нужен для formatting — реализовать. Не менять публичный payload без проверки совместимости.

17. **[Актуальное замечание] `adapters/mt5/mt5_connector.py:154` — symbol_info exception маскируется как отсутствие спецификации.**  
    `symbol_spec` ловит все исключения и возвращает None. Это не позволяет отличить «MT5 не предоставил tick size» от ошибки вызова API; система может незаметно перейти на 0.1. Вернуть/передать диагностический признак `specError` или `specUnavailable` в connect result/session status/health. Не раскрывать секреты и токены в диагностике.

18. **[Актуальное замечание] `server.test.js:445` — не покрыт tick size на history ingest.**  
    Тест проверяет live batch, но не history batch. Добавить history batch со spec и доказать, что footprint rows формируются на 0.01 grid.

19. **[Актуальное замечание] `server.js:121` — отсутствие spec может очищать сохранённый tick size.**  
    Review указывал: undefined/отсутствующий spec трактуется как команда удалить сохранённый размер, хотя старый connector или сессия с ошибкой symbol_info могут просто не прислать поле. Различать отсутствие поля и явный сигнал очистки (например, явное `spec: null`), сохраняя tick size до явной команды или завершения сессии. Добавить регрессионный тест.

20. **[Актуальное замечание] `electron/mt5-session.js:223` — tickSizeIssue не отображается пользователю.**  
    Статус сохраняет `tickSizeIssue`, но `mt5-client.js` render читает ограниченный набор полей. Показать причину отсутствия tick size в status message/UI note либо убрать недостоверное обещание из интерфейса/документации. Проверить desktop UI.

21. **[Актуальное замечание] `app.js:273` — single tick route может использовать другую сетку, чем browser.**  
    Browser округляет live tick по `analysisMeta.footprintStep`, но `/v1/ingest/mt5/tick` не сохраняет spec и server может пересчитать forming bar по 0.1. При refetch цена может перескочить с 0.01 сетки на 0.1. Передавать/использовать одну и ту же spec для single-tick route и batch/history path либо не округлять browser по шагу, которого сервер не применяет. Добавить end-to-end regression test.

### UI, reconnect, licence и resend queue

22. **[Outdated] `app.js` — старые inline ветки footprint display modes расходятся с footprintCell.**  
    Review указывал, что старые bidask/delta/volume branches могут показывать неизвестные ticks иначе, чем `footprintCell`. Проверить текущую реализацию. Все режимы должны использовать один источник cell semantics; добавить проверки unknown-only rows для всех режимов.

23. **[Оспорено автором; не считать подтверждённым дефектом] `footprint-engine.js:325` — value в footprintCell не используется UI.**  
    Автор объяснил, что numeric value — часть экспортируемого результата и полезен тестам/будущим потребителям. Не удалять автоматически. Проверить контракт и сохранить, если он намеренный.

24. **[Outdated] `electron/mt5-session.js` — retry denominator off-by-one.**  
    Review: UI показывает «Повтор N из maxFailures-1», но disconnect наступает при failures >= maxFailures. Проверить актуальный текст и условие. Номер попытки и число максимально допустимых отказов должны совпадать по смыслу.

25. **[Актуальное замечание] `electron/mt5-session.js:127` — ошибка JSON parse licence response проглатывается.**  
    `.catch(() => null)` на response.json() может превратить malformed HTTP 200 в null; `body?.valid === false` тогда не сработает, и сессия может остаться online. Ошибка parse должна вести в retry/error path; unreadable response не считать валидной лицензией. Добавить тест.

26. **[Актуальное замечание] `electron/mt5-session.js:128` — нет теста на явный invalid licence в новом endpoint.**  
    Текущий тест, по review, проверяет старый 402 path, а не `/v1/license/status` с HTTP 200 и `{valid:false}`. Добавить тест, что сессия немедленно уходит offline, а не reconnecting/online.

27. **[Актуальное замечание] `electron/mt5-session.js:81` — resend queue может потерять batch на промежуточной ошибке.**  
    `owner.unsent` очищается до отправки; не все пути (например, JSON parse 409 или rejected resequenced send) возвращают остаток batch в очередь. Обернуть всю обработку одной партии так, чтобы при любой ошибке неотправленные `records.slice(i)` возвращались в очередь и учитывались в dropped metrics. Добавить тесты на каждый failure path.

28. **[Outdated] `electron/mt5-session.js` — droppedTicks может навсегда выглядеть как потеря текущего outage.**  
    Review указывал, что lifetime counter показывается как потеря за время сбоя после восстановления. Проверить актуальную семантику. Либо сбрасывать outage counter после подтверждённой доставки backlog, либо явно маркировать значение как lifetime total; не путать его с текущим outage.

29. **[Актуальное замечание] `app.js:168` — bidask branch отличается от footprintCell.**  
    Engine возвращает точку для row с unknown-only ticks, а UI branch может отобразить пустую ячейку. После проверки текущего кода направить bidask через `footprintCell`, как остальные режимы, и добавить тест на unknown-only row.

30. **[Актуальное замечание] `electron/mt5-session.js:163` — droppedThisOutage может сообщаться повторно.**  
    Счётчик очищается только при пустом unsent, но ingest может очистить очередь до последующего сбоя licence/zones fetch. В результате одно и то же событие потери может повторно отображаться после восстановления. Сбрасывать outage notification после фактического подтверждения/публикации один раз, а не только по состоянию очереди. Добавить тест на ошибку после успешного resend.

31. **[Актуальное замечание] `ui.browser.mjs:460` — browser test использует незарегистрированный hook.**  
    Review указывает, что `window.gold3poBarsForTest` нигде не регистрируется, поэтому state всегда null; собранные wick/down/opacity значения не проверяются. Удалить dead hook или реально зарегистрировать test hook; assert `candles.wick > 0`, `candles.down > 0` и необходимые свойства opacity.

32. **[Актуальное замечание] `electron/mt5-session.js:105` — ошибка resend не объясняет, что batch сохранён.**  
    Сейчас наружу может уйти голый HTTP 500/SyntaxError без контекста очереди. Добавить диагностическое сообщение с route, tick count и явным статусом «сохранено для повторной отправки», только если batch действительно восстановлен в очередь. Не заявлять, что данные сохранены, если это не подтверждено.

## 3. Незавершённые этапы исходного ТЗ

Сам PR прямо помечал эти пункты как **Not done yet**. Их нельзя считать реализованными только потому, что PR слит:

- Полный MT5 re-login после перезапуска терминала и heartbeat в периоды без polling.
- Апгрейд графика.
- Остальные footprint modes: trades count, average trade size, cumulative/session delta, delta profile, stacked-imbalance view.
- ATR-based и automatic row size.
- Per-instrument profiles.
- Exhaustion и unfinished-auction detectors с причинами/порогами.
- DOM и liquidity heatmap — только если broker реально предоставляет market depth.
- Полная settings system.
- Interface audit.
- Walk-forward calibration и out-of-sample trade counts в backtest.
- Полная программа MT5/UI integration tests.
- Implementation report.

## 4. Ограничения проверки и известные environment issues

Из PR description и CI:
- Не проверено на live MT5 broker history и реальном terminal; использовались synthetic candles/ticks и stand-in MetaTrader5/connector.
- MT5 panel texts проверялись через session wiring, а не визуально в desktop app с подключённым terminal.
- Packaged Windows app и startup smoke test не запускались.
- Реальные XAUUSD zone rankings и footprint marks до/после не сравнивались.
- В PR description указаны три server tests с time buckets на границе 15-минутного интервала как flaky; они якобы могут падать и на main. Проверить стабильность и убрать зависимость от текущего времени через фиксированные timestamps.
- Семь существующих Python connector unit tests зависят от Windows terminal paths и падают на Linux также на main; они не входят в CI. Запустить на Windows или корректно изолировать platform-specific checks. Не маскировать реальные connector regressions.

## 5. План работы для исправляющего агента

1. Сначала синхронизироваться с организационным `main` и прочитать этот файл целиком.
2. Не считать все 32 замечания одинаково достоверными: сначала проверить текущий код, особенно outdated threads и пункты с ответом автора.
3. В первую очередь устранить два CI failure (CI-1, CI-2) и добиться воспроизводимого зелёного `npm test`.
4. Затем исправить подтверждённые correctness/data-loss/security/lifecycle проблемы: tick-size lifecycle, single tick vs batch grid, licence parsing, resend queue, zone horizon, absorption threshold.
5. Исправить тестовое покрытие: history ingest spec, invalid licence response, all resend failure paths, browser wick/down, row-size local path, fixed-time imbalance fixtures.
6. Разобрать продуктовые контракты: `ticksPerRow` и signal math; `footprintCell.value`; `digits`; outage vs lifetime counters.
7. Запустить полный набор: `npm test`, `npm run check`, browser tests, MT5 connector selftest. Отдельно прогнать Windows packaged app/startup smoke test и интеграцию с реальным MT5 terminal.
8. Каждый логический блок — отдельный commit или PR с тестами. Не закрывать review thread, пока соответствующее исправление не проверено.
9. После исправлений подготовить отчёт: что исправлено, какие тесты запущены, результаты, что осталось непроверенным на реальном MT5/XAUUSD.

## 6. Критерии готовности

- [ ] Оба текущих CI failure исправлены, причина описана.
- [ ] Все актуальные correctness/data-loss findings проверены и закрыты кодом + regression tests либо аргументированно отклонены.
- [ ] Все outdated findings перепроверены на текущем main; устаревшие/неактуальные замечания отмечены с объяснением.
- [ ] `npm test`, `npm run check`, browser tests и connector selftest проходят.
- [ ] Windows packaged app проверена.
- [ ] MT5 reconnect/re-login/heartbeat проверены на реальном terminal.
- [ ] Footprint grid и XAUUSD результаты проверены на реальных данных.
- [ ] Нереализованные этапы ТЗ либо выполнены, либо вынесены в отдельные tickets с явным статусом.

---
**Важно агенту:** не делать массовый рефакторинг и не менять поведение «для зелёных тестов». Сначала воспроизвести, затем минимально исправить, добавить регрессионный тест и показать результат.

## 7. Follow-up после первоначального аудита

После слияния PR выполнено отдельное минимальное исправление тестовых fixtures в `server.test.js` (commit `da738ddec8f905c0a7c83da058c8c6347889abca`):
- `stackFixture` теперь привязывает базовое время к границе 15-минутной свечи.
- `sweepFixture` использует выровненную 15-минутную временную базу.

Причина: предыдущие fixtures использовали `Date.now()` с произвольными минутами/секундами, из-за чего структура баров менялась при переходе через границу 15-минутного интервала. Последний красный CI запуск пришёлся на 17:14 UTC, за секунды до такой границы. Это вероятная общая причина нестабильности сигналов в данных тестах, но **исправление пока не подтверждено повторным успешным CI**. Повторно запустить `npm test` и убедиться, что оба падения исчезли; если они сохраняются — продолжить исследование генерации stack/reference signal, не ослабляя assertions.

После push автоматически запущен Quality gates run #43: https://github.com/ORSP-w/gold-3Po-/actions/runs/45253937553. Повторная проверка уже подтвердила успешные шаги `npm test` и `npm run check`; browser tests/package steps ещё выполнялись на момент последней проверки. Предыдущий run #41 на merge commit также завершился полностью успешно (npm test, check, Playwright browser check и packaging): https://github.com/ORSP-w/gold-3Po-/actions/runs/45253691214.
