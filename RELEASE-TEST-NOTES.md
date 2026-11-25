# GOLD-3Po v1.1.0 — live feed, chart and footprint test

1. **Live feed.** With MT5 connected, the price strip, the last candle and the forming footprint column move with every tick, without waiting for a refresh. The ⟳ buttons above the chart and the footprint reload the window from MT5 (the connector also re-reads recent history with `copy_ticks_from`).
2. **No freeze on a long history.** The service keeps the tick window per account and builds candles incrementally (`tick-store.js`); a window of about a million ticks answers in milliseconds, and late history is merged in time order.
3. **Chart.** Drag to pan (time and price), wheel to zoom time around the cursor, drag the price axis to stretch prices, drag the time axis to squeeze bars, double click to fit again. Timeframe buttons 1м–4ч switch the chart and the footprint together.
4. **Footprint.** Same gestures. The row size is one fixed setting (selector in the footprint header, «1 шаг» = the broker tick, as in the pre-auto builds) used both for the math and for the picture; it never changes by itself. «Обзор» fits the visible candles, «Y−/Y+» change the row height.
5. **Zones.** Zone detection is the same as in the build the math was last verified on (no intra-bar re-ranking).

# GOLD-3Po v0.8.0 — Electron Windows installer test

## Install and launch

1. Download `GOLD-3Po-Setup-*.exe` from the latest GitHub pre-release.
2. Run the setup wizard. This is a per-user install and does not require administrator rights.
3. Leave the launch option enabled or start **GOLD-3Po Market Lab** from the desktop shortcut or Start Menu.
4. The application opens in its own Electron window. It starts its local market API on `127.0.0.1:8787`.

The application bundles Electron and its Chromium runtime. A separate Node.js installation, browser window, PowerShell command or ZIP extraction is not required. The MT5 connector is bundled as a standalone executable (`resources\mt5-runtime\gold3po-mt5\gold3po-mt5.exe`); a separate Python installation is not required.

## MT5 connection, indicator and tray (v0.5.0)

1. Activate the licence, then press **Подключить MT5**, choose the broker `terminal64.exe`, enter account/server/password (demo or investor password recommended) and the exact gold symbol.
2. Confirm the status becomes online and the symbol label matches the broker symbol (suffixes such as `XAUUSDm` are supported).
3. Press **Скопировать индикатор в MT5**, compile `Gold3PoLevels.mq5` if MetaEditor did not auto-compile, and attach it to the gold chart. Levels must appear and refresh; disconnecting must clear them within the indicator stale timeout.
4. Minimize and close the window: the app must stay in the tray and keep the API alive; tray **Exit** must stop it.
5. Verify no order is ever sent: the connector exposes no trading operations.
6. Glass design: panels, buttons and dialogs render with the Vespera-style translucent glass surfaces; all controls remain clickable at desktop and mobile widths.
7. Settings (⚙ in the top bar or the rail): Zones tab — min/max zone count (default 3–7), timeframe, swing sensitivity, cluster width, zone thickness, search distance, ATR period, the number of bars used to measure a reaction, and a switch for each level source (previous day, sessions, week, higher timeframes, volume profile). The chart, `/v1/chart/zones` and the MT5 indicator must follow them.
8. MT5 drawing: by default zones are red solid lines (width 2). Change colour, line style, width, fill, labels and strength % in **Отрисовка в MT5**; the attached Gold3PoLevels indicator must update within ~5 s without being re-attached. Dashed/dotted styles are width 1 (MT5 limitation). The chart caption must read in Russian, exactly like the panel («Максимум прошлого дня | ПРОВЕРЕНА | 72%»), because the snapshot reuses `zone-labels.js`.
9. Interface tab: switch between the dark and light Vespera themes; the choice persists after restart.

Settings are stored in `%APPDATA%\GOLD-3Po Market Lab\settings.json`. The local market archive is stored in `%APPDATA%\GOLD-3Po Market Lab\market-events.jsonl`. The licence key and clock watermark are stored in `license.json` / `license-state.json` in the same folder. These files are outside the installation folder and are retained when the application is updated or uninstalled.

## Zones and their evidence (v0.8.0)

1. Zones are built from several independent sources in the same broker history: swing pivots, the previous completed day's high/low, the Asia / London / New York session extremes, the weekly open and previous week extremes, H1 and H4 swings aggregated from the same candles, the volume profile (POC, value-area edges) and round numbers.
2. When several sources land inside one zone, its strength rises (the `confluence` factor). A zone row shows the reaction evidence, and hovering it lists the sources that agree.
3. Reaction evidence is measured, not assumed: `zone-reaction.js` walks the history and counts, per zone, how many touches held (price moved 0.5 ATR away from the edge) versus closed through it (0.25 ATR). The panel footer sums this as «N удержаний из M касаний».
4. That measurement uses the same history the zones were built from, so it is evidence about the past, not a forecast. It is not a calibrated probability and must not be read as one.
5. The chart fills the panel at any window size, including 4K; the workspace widens above 1800 px instead of staying at 1680 px. Since v1.1.0 the chart is a canvas navigated like TradingView (see the v1.1.0 section): older history is reached by dragging, not by a scroll strip. Primary buttons use the gold C-3PO accent in both themes.
6. Every source has its own switch in **Зоны → Источники уровней**. Turning one off removes its levels from the search and from the confluence count; switches are validated server-side (`useVolume must be a boolean`), so a malformed request is rejected instead of silently ignored. Swing pivots always stay as the base.

## Footprint: what the numbers mean (v0.8.0)

1. Every price row comes from real ticks: `footprint-engine.js` buckets each tick by price step and by the side of the aggressor. A row that never traded stays empty; nothing is invented. A tick whose side the broker did not report is kept in a separate «без стороны» column and never guessed.
2. **POC** is the price with the most volume in the bar. The **value area** is the 70% of the bar's volume traded around that POC — the same definition TradingView's volume footprint and Quantower's cluster chart publish. The share is a setting (50–95%).
3. **Imbalance** is diagonal, not horizontal: ask volume at a price against bid volume one level below (a buy imbalance), and the mirror for a sell imbalance. A level counts when the bigger side is at least 300% of the smaller one — the industry default — and the threshold is a setting (150–500%). Three or more imbalanced levels in a row form a **stacked imbalance**.
4. **Absorption** marks an outer row that carried at least twice the median row volume while the bar closed back inside: a passive order soaking up the aggression. **Unfinished auction** marks a bar extreme where both sides still printed — the auction never closed there.
5. The right-hand column is the **session volume profile** with its own VAH / VAL / POC. A POC that later price never traded back through is listed as «голый POC»: these levels tend to act as magnets.
6. **Cumulative delta against price** is checked over the last 20 bars. Price rising while cumulative delta falls (or the mirror) is flagged as a divergence in the inspector instead of being hidden inside a number.
7. The footprint is live: a streamed tick updates the forming bar within a frame, so the last column moves between the 1.5 s refetches. The authoritative analysis still replaces the whole history regularly, so a dropped tick can never leave a permanent error.

These are readings of executed volume from your broker, not a forecast, not a DOM and not exchange order flow. On broker OTC quotes the tick volume is activity, not contracts — the engine only labels a side when MT5 reports an aggressor flag.

## Activate the licence

1. On first launch an activation screen covers the workspace and shows this computer's **Machine ID** (Copy button).
2. Send the Machine ID to the vendor. The vendor issues a signed key: `npm run license-ui` opens the one-window generator (paste the ID, choose the term and edition, copy the key or the ready customer text), or `node tools/make-key.js issue --days 30 --machine <ID>` from the command line. The generator refuses to issue when the private key does not match the public key embedded in the app, so a key can never be handed out that the customer's copy would reject.
3. Paste the whole `GOLD1.…` key into the activation field and press **Activate licence**. No internet is used.
4. The status panel shows `Лицензия · АКТИВНА · N дн.`. When the term expires the activation screen returns; ingest keeps recording data in the background.
5. Rolling the system clock back more than 5 minutes (against the stored watermark or the MT5 feed time) blocks the licence with `CLOCK ROLLBACK` until the correct time is restored.

## Connect RoboForex MT5

1. Start **GOLD-3Po Market Lab** and keep it running.
2. In MT5, open **Tools → Options → Expert Advisors** and allow WebRequest to `http://127.0.0.1:8787`.
3. Open the installed EA source at `resources\adapters\mt5\Gold3PoBridge.mq5` in the GOLD-3Po installation directory using MetaEditor. Press F7 to compile.
4. In GOLD-3Po open **⚙ Настройки → Отрисовка в MT5 → Мост MT5** and press «Скопировать»; the app shows the API address and the ingest token (the same value is `marketIngestToken` in `%APPDATA%\GOLD-3Po Market Lab\settings.json`).
5. Attach the EA to the RoboForex XAUUSD chart. In EA Inputs, paste the copied value into `IngestToken`.
6. Confirm `http://127.0.0.1:8787/health` reports the MT5 feed and the chart leaves the empty state («График пуст») and shows broker history / live data.

The EA is data-only. It cannot place or manage orders. Keep it on a demo account for the initial test.

## What to check

- The main desktop window opens without an external browser.
- Without a licence the activation screen appears; a valid key for this Machine ID unlocks the workspace, a key for another PC is rejected.
- API, MT5 and COMEX connection indicators reflect feed status.
- Chart and footprint update as broker ticks arrive.
- Replay loads a date range, plays, pauses, and returns to live view.
- Backtesting reports trades and metrics when qualifying historical setups exist.
- Risk plan blocks risk above 1% and reward/risk below 1.5:1.
- After closing and reopening the app, imported market history and the activated licence remain available.
- Non-gold symbols (e.g. EURUSD) are rejected by the API; only XAUUSD/GC data is accepted.
- Custom conditions: save a named setup, apply it, confirm signals/backtest/risk defaults follow it; export and re-import the JSON (import creates a new identity, unknown fields are rejected).
- MT5 zone drawing: with the EA attached, liquidity-zone rectangles and labels appear on the XAUUSD chart and refresh every few seconds as new ticks arrive; removing the EA removes all G3P_ objects.
- Bar inspector adds up: «Объём на бид» + «Объём на аск» + «Без стороны» equals «Общий объём», and ticks the broker did not classify are shown in «Без стороны» instead of being guessed.
- A multi-day chart labels the time axis with dates, not a repeating «10:00», and the settings tabs stay on one row on a phone.

An empty replay or zero backtest trades can be a valid result when there is not enough available broker history or no qualifying liquidity-sweep setup.

## Important limits

- Without broker data the workspace shows an empty state («График пуст») instead of demo candles: nothing on the chart is invented. The interface, including research modules, licence screen and status labels, is in Russian.
- RoboForex XAUUSD is OTC/CFD data. It is not centralized COMEX trade flow or exchange volume.
- Real COMEX flow requires a separately licensed provider adapter and entitlement; a live CME feed is not bundled.
- MetaEditor compilation and a real RoboForex feed have not been verified by CI. Confirm those in your own terminal.
- The installer is not digitally code-signed, so Windows SmartScreen may show an unknown-publisher warning.
- Do not use this research build as financial advice or for automated execution. It does not route orders.
