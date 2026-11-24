# GOLD-3Po offline licence keys

GOLD-3Po uses **offline, cryptographically signed licence keys**. There is no licence
server, no phone-home and no internet requirement. A key is bound to one computer and
valid for a fixed number of days (1–9999).

## How it works

- The vendor holds an **Ed25519 private key** (`tools/license-private.pem`, gitignored,
  never shipped). The application embeds only the matching **public key**
  (`LICENSE_PUBLIC_KEY_PEM` in `license.js`).
- A key is `GOLD1.<base64url payload>.<base64url signature>`. The payload contains the
  product id, edition, machine fingerprint, key id, issue time, day count and expiry.
  The signature covers the payload, so **forging or editing a key is impossible without
  the private key**.
- On every gated API call the server verifies the signature, the machine binding and the
  expiry locally. Analysis, replay, backtest, signals, risk and SSE require a valid key
  (HTTP 402 otherwise). **Ingest and `/health` stay open** so an expired licence never
  loses incoming market data.
- The machine fingerprint (`machine-id.js`) hashes the Windows `MachineGuid` plus
  hostname, CPU model and RAM. It changes after an OS reinstall — issue a new key then.

## Vendor workflow (your PC only)

```bash
# Once ever: create the vendor keypair.
node tools/make-key.js init
# -> writes tools/license-private.pem (BACK IT UP OFFLINE, never commit/share)
# -> prints the PUBLIC key; embed it into LICENSE_PUBLIC_KEY_PEM in license.js

# Per customer: they send you their Machine ID (shown on the activation screen).
node tools/make-key.js issue --days 30 --machine AAAA-BBBB-CCCC-DDDD
# optional: --edition pro

# Decode/inspect any key:
node tools/make-key.js inspect --key GOLD1....
```

Send the printed `GOLD1.…` string to the customer through any channel.

## Customer workflow

1. Launch GOLD-3Po. Without a valid key an activation screen covers the workspace and
   shows the **Machine ID** of this computer (with a Copy button).
2. Send the Machine ID to the vendor and receive a key.
3. Paste the whole `GOLD1.…` string and press **Activate licence**.
4. The key is stored beside the application data and survives app updates:
   - Electron desktop: `%APPDATA%\GOLD-3Po Market Lab\license.json` (+ `license-state.json`).
   - Plain Node server: `data/license.json` (+ `data/license-state.json`).
   The status panel shows remaining days; the activation screen reappears on expiry.

## Clock-rollback protection

The server keeps a high-water mark of the newest time it has seen (`data/license-state.json`)
and also compares the system clock against **market feed time** (MT5/COMEX event
timestamps). Rolling the Windows clock back more than 5 minutes below either reference
invalidates the licence with `clock_rollback` until the correct time is restored.

## Development / CI mode

Setting `LICENSE_REQUIRED=0` in the server environment disables the gate
(`status.required=false`, reason `disabled`). This exists so automated UI tests
and local development can run without issuing keys. The shipped installer and
the Electron app never set it. Treat it like any source-level bypass: it is a
development convenience, not a security boundary.

## Honest limits

- The watermark file is local and best effort: deleting `data/license-state.json` resets
  it. The feed-time check still catches rollback while live data arrives.
- Node.js source is readable; a determined person could patch the check out of
  `server.js`. The Electron build packs sources into `app.asar`, which raises the bar
  slightly but is still extractable. Signed keys prevent **key forgery and casual
  sharing**, not reverse engineering. This is the same trade-off every offline-licensed
  desktop app makes.
- There is no online revocation. Prefer shorter terms (30–90 days) for subscriptions;
  a stolen key stops working at its natural expiry.
- If the vendor private key leaks, anyone can issue keys. Keep it offline, back it up,
  and never commit it. `init` refuses to overwrite an existing keypair.

## Key rotation

The pair that was embedded up to 0.9.7.39 had no surviving private half (it was never
committed and never backed up), so no key could be issued at all. On 2026-11-24 the pair
was regenerated, `LICENSE_PUBLIC_KEY_PEM` was replaced, and the new private key was handed
to the vendor for offline storage. Keys signed before that date no longer verify; keys
signed after it verify only in builds from that commit onwards.

When rotating again: `npm run license:init`, paste the printed public key into
`license.js`, rebuild, and only then issue keys — the generator refuses to sign with a
private key that does not match the embedded public key, while `make-key.js issue` does
not check and will happily print an unusable key.

## API

- `GET /v1/license/status` — `{ required, valid, reason, machineId, edition, keyId, issuedAt, expiresAt, daysTotal, daysLeft }` (always open).
- `POST /v1/license/activate` — body `{ "key": "GOLD1.…" }`; 200 on success, 422 on invalid key, 429 after 10 attempts/minute.
- Gated endpoints answer `402 { error: "license_required", reason, machineId }` when no valid licence is present.

## Tests

`license.test.js` covers issuance bounds (1/9999 days), signature forgery, foreign
keypairs, machine binding, expiry, clock rollback (watermark + feed time), persistence,
activation rate limiting and the server gate. `server.test.js` injects a throwaway
test keypair so the existing API tests run against a valid licence.
