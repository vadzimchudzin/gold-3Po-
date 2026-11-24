# RoboForex MT5 bridge

Two integration paths exist:

- **App-side connection (recommended):** on startup GOLD-3Po finds the already-running `terminal64.exe` and attaches with the official MetaTrader5 Python API. It verifies the active account and gold symbol without calling `login()`, requesting a password or changing the active account. The bundled connector streams recent/live gold ticks into the local API and publishes levels to `Common\\Files\\GOLD3PO\\<SYMBOL>.csv`. The custom indicator **`Gold3PoLevels.mq5`** reads that file and draws levels — no WebRequest or DLL is needed for the indicator.
- **EA bridge:** `Gold3PoBridge.mq5` uploads deeper broker tick history (up to 90 days; 30 by default) and can draw zones itself. It complements the app-side live feed; with `AppConnectionFeedsLive=true`, it does not send duplicate live ticks.

The EA never reads or transmits the trading account password. The terminal must already be logged in to the intended broker account and have a gold symbol available in Market Watch.

## Install and configure

1. Open MT5 and sign in to the intended broker account as usual. Make sure the broker's gold symbol is available in Market Watch.
2. Start **GOLD-3Po Market Lab**. It automatically finds the already-running MT5, checks its active account and selects an available `XAUUSD` / `GOLD` symbol. No account login, password or server fields are shown.
3. On every app launch/update, GOLD-3Po copies `Gold3PoBridge.mq5` to `MQL5\\Experts` and `Gold3PoLevels.mq5` to `MQL5\\Indicators`. If MetaEditor is installed next to that terminal, both sources are compiled automatically. If several terminals are running, the app refuses to guess; leave only the intended terminal open and retry.
4. The app writes its local ingest token to `Common\\Files\\GOLD3PO\\bridge-token.txt`. The EA reads it automatically when its `IngestToken` input is left blank. Do not copy the account password or token into an EA parameter.
5. For deep historical backfill, attach one `Gold3PoBridge` EA to one XAUUSD chart. MT5 requires a one-time WebRequest permission: **Tools → Options → Expert Advisors → Allow WebRequest for listed URL**, add `http://127.0.0.1:8787`.
6. Keep `AppConnectionFeedsLive=true` (default): the app owns the recent ~8-hour live stream; the EA fills older history and can draw zones. The app installs/compiles the EA but does not silently attach it to a chart. One attachment is a one-time MT5 action.
7. Check `http://127.0.0.1:8787/health` and the MT5 Experts tab for the preflight result.


## Data flow and recovery

- At startup the EA schedules up to 90 days (30 by default) of broker tick history using hourly `CopyTicksRange` windows. With the desktop feed enabled, backfill stops 8 hours before now so it does not duplicate the recent ticks already supplied by the app.
- The EA is single-instance per symbol (terminal-global lock); attach it once, not to H1/H4/M15 simultaneously. A second instance exits with an explicit Experts-tab message.
- Historical upload defaults to 1,000 ticks per batch with a 5-second request timeout. On WebRequest transport failure the batch is reduced (down to 50) and retried with backoff.
- By default `AppConnectionFeedsLive=true`: the desktop connector owns recent/live ticks; the EA owns deep historical backfill and optional zone drawing. Set it to `false` only when the EA alone should send live quotes.
- When standalone live delivery is enabled, ticks remain queued through HTTP errors and retry with backoff. The queue is capped at 20,000 ticks.
- The terminal must remain open and connected. MT5 WebRequest is synchronous; a slow API can delay the EA's event processing. The local API binds only to loopback.
- API events are appended to `%APPDATA%\GOLD-3Po Market Lab\market-events.jsonl` and reloaded after application restart.
- The calculation API builds 15-minute OHLC bars and price-level activity. The chart supports historical replay; the footprint follows the selected candle.

## Volume semantics

RoboForex XAUUSD is an OTC/CFD instrument, not centralized COMEX futures. The EA forwards MT5 tick fields and flags. Bid/Ask aggressor classification is used only when MT5 provides explicit BUY/SELL flags. Otherwise events remain in the `unknown` bucket and count as one tick of activity, not as broker-reported volume. No exchange volume is fabricated.

The 30-day history request means “up to the history available from the broker and terminal”. It cannot guarantee a complete month of ticks. Check the available event count, gaps and feed age before interpreting a chart as complete.

## Live liquidity-zone drawing (v2.20)

With `DrawZones=true` (default) the EA polls `GET /v1/chart/zones?symbol=XAUUSD` every `ZonesRefreshSeconds` (default 5) and redraws the detected liquidity zones on the chart:

- Zones above price (buy-side) and below price (sell-side) are drawn as rectangles in the colours, line style, width and fill chosen in the app (**Settings → Отрисовка в MT5**; default red solid lines). Set `UseAppStyle=false` to use the EA inputs (`BuyZoneColor`, `SellZoneColor`, `ZoneLineStyle`, `ZoneLineWidth`) instead.
- Each rectangle spans `ZoneLookbackBars` (default 200) of history into the near future and carries a label `side LQ strength distance` plus a tooltip.
- A status line in the top-left corner shows zone counts and the last refresh time.
- The MT5 zones route returns only flat drawing fields (`id`, `side`, bounds, strength, label, distance and state). Full reaction/source/factor detail remains in the desktop analysis API; the flat shape avoids the EA's lightweight parser stopping at nested JSON.
- Zones are rebuilt from the latest market analysis on every refresh, so they **follow the market**: new repeated levels appear, consumed levels disappear.
- All objects use the `G3P_` prefix and are removed when the EA is detached.
- If the licence is missing/expired (`402`), the EA clears the zones and shows a licence-required notice; tick ingestion continues regardless.

Zones are built from several independent sources (swings, the previous day's high/low, session extremes, the previous week, H1/H4 swings, the volume profile and round numbers) and scored by measured past reactions plus how many sources agree. They are not confirmed order-book depth, and a reaction at a zone is probable, not guaranteed.

## Operational boundary

- GOLD-3Po copies and attempts to compile both MQL5 sources through MetaEditor on the user's PC. GitHub Actions does not include the proprietary MT5 MetaEditor runtime, so the real MQL5 compilation result is reported by the application on that PC.
- The desktop application and MT5 terminal run on the same machine through localhost. For a shared central feed, deploy the API behind HTTPS and configure the EA URLs to that server.
- The EA only sends market data. It never submits, modifies or closes orders.
- The EA source has not been certified against a live RoboForex account in this repository workflow; verify MetaEditor compilation and a demo-account feed before relying on it.
