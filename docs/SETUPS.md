# GOLD-3Po strategy profiles — Vespera-style setup library

GOLD-3Po borrows Vespera's saved-setup model, adapted for a read-only research
workspace: **named setups, append-only immutable versions, strict JSON
import/export, explicit apply**. A setup never contains tokens, keys, personal
data or execution state — only research conditions.

## What a setup contains

| Section | Fields |
|---|---|
| `strategy` | `minScore` (0–1), `atrPeriod` (1–200), `requireRejection`, `requireCloseEdge`, `requireStacked`, `requireDeltaAgree` (booleans), `allowedSides` (`long`/`short` subset), `sessionHoursUTC` (`null` or `[start, end)`), `minAtr` (price units). `maxZones` is still accepted for old exports but ignored: the zone count lives in **Settings → Zones** (`/v1/settings`) |
| `zones` | optional (`null` = leave as is): the zone search from **Settings → Zones** |
| `footprint` | optional (`null` = leave as is): the footprint settings from **Settings → Footprint** |

`backtest` and `risk` sections from exports made before 1.2.0 are still accepted
on import and dropped — the backtester and risk planner were removed.

Unknown fields are **rejected**, not ignored — importing a settings/profile file
as a setup fails loudly, exactly like Vespera.

## Behaviour

- **Save** captures the current editor conditions under a name. Saving the same
  name again appends a new immutable version; identical conditions are
  deduplicated by SHA-256 fingerprint. Editing live fields never rewrites a
  saved version.
- **Apply** selects a setup version. The applied conditions drive
  `/v1/market/signals` and the signal marks and alerts on the chart; a profile
  that carries `zones`/`footprint` switches those settings too. There is no
  executor here, so apply is always safe — the app never sends orders.
- **Delete** removes a profile with all its versions; **Reset** returns to the
  built-in conditions and leaves zone and footprint settings as they are.
- **Export** downloads one version as JSON. **Import** always creates a new
  setup identity; it never modifies history and never auto-applies.
- The library persists in `data/setups.json` (Node server) or
  `%APPDATA%\GOLD-3Po Market Lab\setups.json` (Electron) and survives updates.
- All setup endpoints are licence-gated (`402` without a valid key).

## API

- `GET /v1/setups` — library, active selection and effective definition.
- `POST /v1/setups` — `{ name, definition }` → save (new version).
- `POST /v1/setups/apply` — `{ id, version? }` → apply (latest when omitted).
- `GET /v1/setups/export?id=…&version=…` — one version as JSON.
- `POST /v1/setups/import` — `{ name, definition }` → new identity.
- `DELETE /v1/setups?id=…` — delete a profile.
- `POST /v1/setups/clear` — back to the built-in conditions.

## MT5 liquidity-zone drawing

The EA (`adapters/mt5/Gold3PoBridge.mq5`, v2.10) polls `GET /v1/chart/zones`
every `ZonesRefreshSeconds` (default 5) and draws the detected liquidity zones
directly on the MT5 chart:

- buy-side zones: teal rectangles; sell-side: red rectangles (`BuyZoneColor` /
  `SellZoneColor` inputs), spanning `ZoneLookbackBars` into the future;
- each zone carries a label (`side LQ strength distance`) and a tooltip;
- a status line shows zone counts and the last update time;
- zones are redrawn from scratch on every refresh, so they **follow the market**:
  new repeated swing levels appear, consumed ones disappear;
- without a valid licence the EA clears the zones and shows
  «licence required» on the chart; ingest keeps running regardless.

The EA remains data-only: it draws objects and uploads ticks, it never trades.

## Honest limits

- Conditions are filters, not a profit guarantee; there is no built-in
  backtest, so validate a profile on your own data before relying on it.
- Zone drawing is a heuristic overlay (repeated swing levels), not order-book
  depth; reactions at zones are probabilistic, not guaranteed.
- MQL5 compilation and live drawing must be verified in MetaEditor/MT5; CI does
  not run a terminal.
