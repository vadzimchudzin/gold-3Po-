# GOLD-3Po — Market Lab

GOLD-3Po is a read-only, **gold-only** market-structure research workspace (XAUUSD via MT5, GC futures via COMEX). It does not route, place, modify or close trades, and it rejects non-gold symbols at the ingest boundary.

## Implemented parts

1. **Liquidity & Footprint workspace:** interactive OHLC chart, 3–7 ATR-based liquidity zones collected from several independent sources (swing clusters with role flips, the previous day and week, session extremes, H1/H4 swings, the volume profile and round numbers), ranked by measured reactions, touches, recency, volume, source confluence and distance, Bid × Ask / Delta / Volume footprint modes with per-bar POC and 70% value area, diagonal 300% imbalances, stacked imbalances, absorption, unfinished auctions, the session volume profile (VAH/VAL/POC, naked POC) and a live forming bar, bar inspector, selection and reset. The desktop workspace supports TradingView-style side-by-side price/liquidity and footprint panels, a draggable splitter, independent horizontal/vertical footprint zoom, and one synchronized timeframe for candles, zones and footprint.
2. **Market data transport:** authenticated MT5 tick and history ingestion, sequenced live batches, COMEX normalized trade contract, SSE, health checks and append-only JSONL persistence.
3. **Market engine:** OHLC aggregation, price-level activity, Delta, Cumulative Delta, adjacent and stacked imbalance candidates, repeated liquidity pools, sweeps/reclaims, and conservative unknown-side handling.
4. **Historical research:** date-range replay, bar-by-bar playback, a rules-based backtester, ATR stops, R-multiple targets, conservative stop-first handling when stop and target are touched in the same candle.
5. **Decision support:** evidence-scored liquidity-sweep signals, walk-forward historical win-rate calibration, browser alerts, position sizing and risk guardrails.
6. **Offline licensing:** Ed25519-signed licence keys bound to one computer, valid 1–9999 days, verified locally with no licence server; activation screen, clock-rollback protection and a vendor-side key generator. See `LICENSE-KEYS.md`.
7. **Custom conditions (Vespera-style setup library):** named setups with append-only immutable versions, strict JSON import/export and explicit apply; conditions drive signals, backtest defaults and risk guardrails. See `docs/SETUPS.md`.
8. **MT5 zone drawing:** the EA polls `/v1/chart/zones` and draws live zones on the MT5 chart in the colours/line style chosen in ⚙ Настройки (default: red solid lines), refreshed as the market evolves. Data-only, never trades.
9. **MT5 connection from the app:** GOLD-3Po automatically finds an already-running, already-authorized MT5 terminal and attaches through the official MetaTrader5 Python API without asking for login, password or server. On each launch it repairs and compiles the `Gold3PoBridge` EA and `Gold3PoLevels` indicator when MetaEditor is available. Live ticks flow through the app-side connector; the optional EA backfills deeper history. See `docs/MT5-CONNECT.md`.

## Windows desktop application

The Windows desktop build uses Electron. It opens GOLD-3Po in its own application window and runs the market API locally on `127.0.0.1:8787`; it does not open an external browser and does not require a separate Node.js installation.

Download **GOLD-3Po-Setup-*.exe** from the latest GitHub release, run the installer, and follow the setup wizard. The installer creates Start Menu and desktop shortcuts. It is a per-user install and does not require administrator rights.

On first launch, the application creates a local ingestion token and settings file. Application settings and market history are stored outside the installation directory so they survive application updates and uninstallation:

- Windows settings: `%APPDATA%\GOLD-3Po Market Lab\settings.json`
- Zone and MT5 drawing settings (⚙ Настройки): `%APPDATA%\GOLD-3Po Market Lab\zone-settings.json`
- Market archive: `%APPDATA%\GOLD-3Po Market Lab\market-events.jsonl`
- Licence key and clock watermark: `%APPDATA%\GOLD-3Po Market Lab\license.json` and `license-state.json`

On first launch an activation screen shows this computer's **Machine ID**. Send it to the vendor, receive a signed `GOLD1.…` key and paste it to activate. Keys are bound to one computer and valid 1–9999 days; everything is verified offline. See `LICENSE-KEYS.md`.

The packaged MT5 sources are automatically copied into the connected terminal's `MQL5\Experts` and `MQL5\Indicators` folders and compiled with MetaEditor when it is available. For deep historical backfill, attach `Gold3PoBridge` once to a gold chart and add `http://127.0.0.1:8787` to the MT5 WebRequest allow-list. Its local API token is read automatically from `Common\Files\GOLD3PO\bridge-token.txt`; no account credentials or manual token entry are required.

The installer workflow runs unit tests and JavaScript syntax checks, packages the Windows x64 NSIS installer, installs it on a clean runner, starts the installed application in smoke-test mode, and publishes the installer with a SHA-256 checksum. The installer is not code-signed; Windows may show an unknown-publisher warning.

## Build the desktop application

Requires Node.js 22 or newer for development.

```bash
npm install
npm test
npm run check
npm run start:desktop
```

Build a Windows x64 installer on Windows:

```powershell
npm install
npm run dist:win
```

The setup executable is written to the `release` directory.

## Run the API without Electron

```bash
cp .env.example .env
# Set MARKET_INGEST_TOKEN to a random secret of at least 24 characters.
npm start
```

Open `http://127.0.0.1:8787`. The API and UI are served from the same origin. `npm run serve` starts a static preview only and does not provide the API.

## API

All ingest endpoints require `Authorization: Bearer <MARKET_INGEST_TOKEN>` and accept gold symbols only: `XAUUSD` (including broker suffix variants such as `XAUUSD.`) for MT5 and `GC…` futures for COMEX; other symbols return `422`. Analysis, replay, backtest, signals, risk and SSE additionally require a valid offline licence key (`402 license_required` otherwise); ingest and health stay open so expired licences never lose market data.

- `GET /health` — server, storage, feed freshness and active SSE clients.
- `GET /v1/license/status` — licence state and this computer's Machine ID (always open).
- `POST /v1/license/activate` — activate a signed `GOLD1.…` key (rate-limited).
- `POST /v1/ingest/mt5/tick` — single MT5 quote event.
- `POST /v1/ingest/mt5/live-batch` — ordered, idempotent live MT5 batch (used by the EA).
- `POST /v1/ingest/mt5/history` — historical MT5 batch; history event identity is separate from the live sequence.
- `POST /v1/ingest/comex/trade` — normalized exchange trade from a licensed data provider.
- `GET /v1/market/snapshot?symbol=XAUUSD&limit=100` — recent normalized events.
- `GET /v1/market/analysis?symbol=XAUUSD&source=mt5&intervalMs=900000` — footprint and liquidity analysis. `source` can be `mt5` or `comex`.
- `GET /v1/market/replay?symbol=XAUUSD&from=...&to=...` — historical bars for replay; supports `source=mt5|comex`.
- `GET /v1/market/backtest?symbol=XAUUSD&riskPct=0.5&pointValue=1` — historical simulation. Supports `source=mt5|comex`.
- `GET /v1/market/signals?symbol=XAUUSD` — latest evidence-scored setup and chronological calibration.
- `GET /v1/risk/plan?equity=10000&riskPct=0.5&entry=2650&stop=2645&target=2660&pointValue=1` — position size and risk checks.
- `GET /v1/stream` — server-sent event stream.
- `GET /v1/chart/zones?symbol=XAUUSD` — lightweight zone payload for the MT5 EA (licence-gated).
- `GET /v1/setups`, `POST /v1/setups`, `POST /v1/setups/apply`, `GET /v1/setups/export`, `POST /v1/setups/import` — Vespera-style setup library (licence-gated). See `docs/SETUPS.md`.

By default the API appends events to `./data/market-events.jsonl`, reloads that archive on restart, and retains the latest 1,000,000 events in memory for analysis. The JSONL archive is not automatically compacted. Plan disk retention and backup for a long-running production deployment.

## Interpretation and limits

**RoboForex XAUUSD:** this is broker OTC/CFD quote data. Its tick volume is not centralized exchange trade volume. The engine uses explicit MT5 aggressor flags only; otherwise ticks remain unclassified. Do not interpret the broker-derived footprint as a full exchange order-flow footprint.

**COMEX GC:** the ingestion and analysis contract works with normalized exchange trades, including actual trade size and provider-supplied aggressor side. This repository does not include a live CME/COMEX vendor connector. A licensed vendor, contract entitlement, credentials and provider-specific adapter must be selected before real exchange trades can be received. See `adapters/comex/README.md`.

**Backtesting:** signals are evaluated at candle close and entered at the next candle open. If one candle touches both stop and target, the simulator assumes the stop occurred first. P&L sizing uses the supplied `pointValue`; set it to the broker's actual instrument contract value. Defaults are research placeholders, not broker specifications. Fees and slippage can be supplied through API parameters.

**Signals and probabilities:** the technical score is an evidence-weighted heuristic, not a probability. The API withholds probability until at least 30 prior same-direction trades have closed. Thereafter it reports a walk-forward historical win rate with a Laplace prior; that statistic is not a guarantee or a forward-looking forecast. Validate out of sample before using it.

**Risk controls:** the planner blocks risk above the configured cap and reward/risk below the minimum. It calculates a plan only; there is no order execution or broker-side enforcement.

## Verification

`npm test` covers the market engine, replay/backtest/risk APIs, tick idempotency and UI contracts. `npm run check` checks JavaScript syntax, including the Electron main process. The GitHub Actions quality workflow additionally launches Chromium, checks UI controls and responsive overflow, and saves screenshots. MQL5 compilation and live RoboForex validation still require MetaEditor and an authenticated MT5 terminal.
