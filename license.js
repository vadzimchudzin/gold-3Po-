import { createHash, randomBytes, sign as cryptoSign, verify as cryptoVerify, createPublicKey, createPrivateKey } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getMachineId, normalizeMachineId } from './machine-id.js';

// Public half of the vendor Ed25519 keypair. The private half lives ONLY in
// tools/license-private.pem on the vendor machine and is gitignored.
// Anyone can verify keys with this public key; nobody can forge keys without the private half.
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJ5m7ZD0WB9jNgNsl9wxVG981Z5Z7ZjyLei6RgNAhPzs=
-----END PUBLIC KEY-----`;

export const KEY_PREFIX = 'GOLD1';
export const PRODUCT_ID = 'gold-3po';
export const MIN_DAYS = 1;
export const MAX_DAYS = 9999;
const DAY_MS = 86400000;
const DEFAULT_CLOCK_TOLERANCE_MS = 5 * 60000;

// Short fingerprint of the embedded public key. Keys are signed by a private half that must match
// it, so this is what tells "the app is older than the key" apart from "the key was mangled".
export function publicKeyId(publicKeyPem = LICENSE_PUBLIC_KEY_PEM) {
  return createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 8).toUpperCase();
}

export function issueLicenseKey({ privateKeyPem, machineId, days, edition = 'pro', nowMs = Date.now(), keyId }) {
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new TypeError(`days must be an integer between ${MIN_DAYS} and ${MAX_DAYS}`);
  const machine = normalizeMachineId(machineId);
  if (!/^[0-9A-F]{16}$/.test(machine)) throw new TypeError('machineId must be 16 hex characters (XXXX-XXXX-XXXX-XXXX)');
  if (typeof edition !== 'string' || !edition.trim() || edition.length > 32) throw new TypeError('Invalid edition');
  const issuedAt = nowMs;
  const payload = {
    v: 1,
    product: PRODUCT_ID,
    edition: edition.trim(),
    machine,
    keyId: typeof keyId === 'string' && keyId ? keyId : randomBytes(6).toString('hex'),
    issuedAt,
    days,
    expiresAt: issuedAt + days * DAY_MS
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, Buffer.from(encoded, 'utf8'), privateKey).toString('base64url');
  return `${KEY_PREFIX}.${encoded}.${signature}`;
}

export function verifyLicenseKey(key, { publicKeyPem = LICENSE_PUBLIC_KEY_PEM, machineId, nowMs = Date.now(), clockToleranceMs = DEFAULT_CLOCK_TOLERANCE_MS } = {}) {
  const fail = reason => ({ valid: false, reason, payload: null });
  if (typeof key !== 'string' || !key.trim()) return fail('missing_license');
  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX || !parts[1] || !parts[2]) return fail('malformed_key');
  let payload; let payloadBytes; let signature;
  try {
    payloadBytes = Buffer.from(parts[1], 'utf8');
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    signature = Buffer.from(parts[2], 'base64url');
  } catch { return fail('malformed_key'); }
  let signatureOk = false;
  try { signatureOk = cryptoVerify(null, payloadBytes, createPublicKey(publicKeyPem), signature); } catch { signatureOk = false; }
  if (!signatureOk) return fail('bad_signature');
  if (payload?.v !== 1 || payload?.product !== PRODUCT_ID) return fail('wrong_product');
  if (!Number.isInteger(payload.days) || payload.days < MIN_DAYS || payload.days > MAX_DAYS) return fail('invalid_days');
  if (!Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt) || payload.expiresAt - payload.issuedAt !== payload.days * DAY_MS) return fail('invalid_dates');
  if (normalizeMachineId(payload.machine) !== normalizeMachineId(machineId)) return fail('wrong_machine');
  if (nowMs > payload.expiresAt) return fail('expired');
  if (nowMs + clockToleranceMs < payload.issuedAt) return fail('not_yet_valid');
  return { valid: true, reason: 'ok', payload };
}

// Tracks the highest timestamp ever observed (system clock and market feed time)
// so rolling the Windows clock back does not extend a licence.
// Best effort: deleting data/license-state.json resets the watermark, which is
// documented honestly in LICENSE-KEYS.md. The signature itself cannot be forged.
export function createLicenseManager({
  publicKeyPem = LICENSE_PUBLIC_KEY_PEM,
  machineId = getMachineId(),
  now = () => Date.now(),
  licenseFile = './data/license.json',
  stateFile = './data/license-state.json',
  initialKey = null,
  required = true,
  clockToleranceMs = DEFAULT_CLOCK_TOLERANCE_MS
} = {}) {
  let key = initialKey;
  let state = { lastSeenMs: 0, keyId: null };
  let loaded = false;
  let lastPersistedMs = 0;

  async function load() {
    if (loaded) return;
    loaded = true;
    if (!key && licenseFile) {
      try { const stored = JSON.parse(await readFile(licenseFile, 'utf8')); if (typeof stored.key === 'string') key = stored.key; } catch { /* no licence yet */ }
    }
    if (stateFile) {
      try {
        const stored = JSON.parse(await readFile(stateFile, 'utf8'));
        if (Number.isFinite(stored.lastSeenMs)) state.lastSeenMs = stored.lastSeenMs;
        if (typeof stored.keyId === 'string') state.keyId = stored.keyId;
      } catch { /* fresh state */ }
    }
  }

  async function persistState() {
    if (!stateFile) return;
    try { await mkdir(dirname(stateFile), { recursive: true }); await writeFile(stateFile, JSON.stringify(state), 'utf8'); } catch { /* state is best effort */ }
  }

  async function status(externalNowMs = 0) {
    await load();
    const nowMs = now();
    const base = { required, machineId, publicKeyId: publicKeyId(publicKeyPem), keyId: null, edition: null, issuedAt: null, expiresAt: null, daysTotal: null, daysLeft: 0 };
    if (!required) return { ...base, valid: true, reason: 'disabled' };
    const result = verifyLicenseKey(key, { publicKeyPem, machineId, nowMs, clockToleranceMs });
    // Clock-rollback watermark: compare against both the persisted high-water mark
    // and the external market-feed clock (MT5/COMEX event timestamps).
    let clockReason = null;
    if (state.lastSeenMs && nowMs + clockToleranceMs < state.lastSeenMs) clockReason = 'clock_rollback';
    if (Number.isFinite(externalNowMs) && externalNowMs > 0 && nowMs + clockToleranceMs < externalNowMs) clockReason = 'clock_rollback';
    const advanced = Math.max(state.lastSeenMs, nowMs, Number.isFinite(externalNowMs) ? externalNowMs : 0);
    if (advanced > state.lastSeenMs) {
      state.lastSeenMs = advanced;
      if (advanced - lastPersistedMs > 60000) { lastPersistedMs = advanced; persistState(); }
    }
    if (!result.valid) return { ...base, valid: false, reason: clockReason && result.reason === 'expired' ? clockReason : result.reason };
    if (clockReason) return { ...base, valid: false, reason: clockReason };
    if (state.keyId !== result.payload.keyId) { state.keyId = result.payload.keyId; persistState(); }
    return {
      ...base,
      valid: true,
      reason: 'ok',
      keyId: result.payload.keyId,
      edition: result.payload.edition,
      issuedAt: result.payload.issuedAt,
      expiresAt: result.payload.expiresAt,
      daysTotal: result.payload.days,
      daysLeft: Math.max(0, Math.ceil((result.payload.expiresAt - nowMs) / DAY_MS))
    };
  }

  async function activate(candidate) {
    await load();
    const nowMs = now();
    const result = verifyLicenseKey(candidate, { publicKeyPem, machineId, nowMs, clockToleranceMs });
    if (!result.valid) return { ...(await status()), valid: false, reason: result.reason };
    key = candidate.trim();
    if (licenseFile) {
      try { await mkdir(dirname(licenseFile), { recursive: true }); await writeFile(licenseFile, JSON.stringify({ key, activatedAt: new Date(nowMs).toISOString() }), 'utf8'); }
      catch { return { ...(await status()), valid: false, reason: 'license_write_failed' }; }
    }
    state.keyId = result.payload.keyId;
    await persistState();
    return status();
  }

  return { status, activate, machineId };
}
