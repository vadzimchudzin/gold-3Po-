"""Licence signing core: no GUI imports, so CI can test it headless.

Byte-for-byte compatible with license.js — see the module docstring in keygen.py.
"""

import base64
import json
import os
import secrets
import time
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

KEY_PREFIX = "GOLD1"
PRODUCT_ID = "gold-3po"
MIN_DAYS = 1
MAX_DAYS = 9999
DAY_MS = 86_400_000
PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJ5m7ZD0WB9jNgNsl9wxVG981Z5Z7ZjyLei6RgNAhPzs=
-----END PUBLIC KEY-----"""

REASONS = {
    "missing_license": "Ключ не введён.",
    "malformed_key": "Ключ повреждён: ожидается GOLD1.<payload>.<подпись>.",
    "bad_signature": "Подпись неверна — ключ выпущен другой парой (или обрезан при копировании).",
    "wrong_product": "Ключ от другого продукта.",
    "invalid_days": "Некорректный срок в ключе.",
    "invalid_dates": "Некорректные даты в ключе.",
    "wrong_machine": "Ключ выдан для другого ID компьютера.",
    "expired": "Срок действия ключа истёк.",
    "not_yet_valid": "Дата выпуска в будущем — проверьте часы.",
    "ok": "Ключ действителен.",
}


def base_dir() -> Path:
    import sys

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


CONFIG_PATH = base_dir() / "keygen-config.json"
JOURNAL_PATH = base_dir() / "license-issued.csv"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def normalize_machine_id(value: str) -> str:
    """The app accepts XXXX-XXXX-XXXX-XXXX in any case and compares the 16 hex digits."""
    cleaned = "".join(ch for ch in str(value or "") if ch.isalnum()).upper()
    return cleaned


def issue_key(private_key: Ed25519PrivateKey, machine_id: str, days: int, edition: str, key_id: str = "") -> str:
    machine = normalize_machine_id(machine_id)
    if len(machine) != 16 or any(ch not in "0123456789ABCDEF" for ch in machine):
        raise ValueError("ID компьютера должен быть 16 hex-символов: XXXX-XXXX-XXXX-XXXX")
    if not isinstance(days, int) or not MIN_DAYS <= days <= MAX_DAYS:
        raise ValueError(f"Срок должен быть целым числом от {MIN_DAYS} до {MAX_DAYS} дней")
    edition = (edition or "").strip()
    if not edition or len(edition) > 32:
        raise ValueError("Издание: непустая строка до 32 символов")
    issued_at = int(time.time() * 1000)
    payload = {
        "v": 1,
        "product": PRODUCT_ID,
        "edition": edition,
        "machine": machine,
        "keyId": key_id or secrets.token_hex(6),
        "issuedAt": issued_at,
        "days": days,
        "expiresAt": issued_at + days * DAY_MS,
    }
    # Key order and separators must match JSON.stringify in license.js: the signature covers the
    # encoded string, and the verifier rebuilds it from the parsed payload only for display.
    encoded = b64url(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = b64url(private_key.sign(encoded.encode("utf-8")))
    return f"{KEY_PREFIX}.{encoded}.{signature}"


def verify_key(key: str, machine_id: str = "", now_ms: int = 0, public_pem: str = PUBLIC_KEY_PEM) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    fail = lambda reason: {"valid": False, "reason": reason, "payload": None}
    if not isinstance(key, str) or not key.strip():
        return fail("missing_license")
    parts = key.strip().split(".")
    if len(parts) != 3 or parts[0] != KEY_PREFIX or not parts[1] or not parts[2]:
        return fail("malformed_key")
    try:
        payload_bytes = parts[1].encode("utf-8")
        payload = json.loads(b64url_decode(parts[1]).decode("utf-8"))
        signature = b64url_decode(parts[2])
    except Exception:
        return fail("malformed_key")
    public_key = serialization.load_pem_public_key(public_pem.encode("ascii"))
    assert isinstance(public_key, Ed25519PublicKey)
    try:
        public_key.verify(signature, payload_bytes)
    except InvalidSignature:
        return fail("bad_signature")
    if payload.get("v") != 1 or payload.get("product") != PRODUCT_ID:
        return fail("wrong_product")
    days = payload.get("days")
    if not isinstance(days, int) or not MIN_DAYS <= days <= MAX_DAYS:
        return fail("invalid_days")
    issued_at, expires_at = payload.get("issuedAt"), payload.get("expiresAt")
    if not isinstance(issued_at, (int, float)) or not isinstance(expires_at, (int, float)):
        return fail("invalid_dates")
    if expires_at - issued_at != days * DAY_MS:
        return fail("invalid_dates")
    if machine_id and normalize_machine_id(payload.get("machine")) != normalize_machine_id(machine_id):
        return fail("wrong_machine")
    if now_ms > expires_at:
        return fail("expired")
    if now_ms + 5 * 60_000 < issued_at:
        return fail("not_yet_valid")
    return {"valid": True, "reason": "ok", "payload": payload}


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except Exception:
        return {}


def save_config(config: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(config, indent=2, ensure_ascii=False), "utf-8")
    except Exception:
        pass


def find_private_key() -> Path | None:
    candidates = []
    configured = load_config().get("privateKeyPath")
    if configured:
        candidates.append(Path(configured))
    candidates.append(base_dir() / "license-private.pem")
    candidates.append(base_dir() / "tools" / "license-private.pem")
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate
    return None


def read_private_key(path: Path) -> Ed25519PrivateKey:
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("Это не Ed25519-ключ")
    return key




def selftest(private_key_pem: str, machine_id: str = "A8E4-1965-47C1-C929", public_pem: str = "") -> dict:
    """Sign, verify, and prove that a tampered key is rejected. Used by CI and by hand.

    Verifies against the public half derived from the given private key unless one is passed in, so
    the test exercises the signing rules rather than which key happens to be embedded.
    """
    key = serialization.load_pem_private_key(private_key_pem.encode("ascii"), password=None)
    derived = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")
    public_pem = public_pem or derived
    issued = issue_key(key, machine_id, 30, "pro")
    ok = verify_key(issued, machine_id, public_pem=public_pem)
    other = verify_key(issued, "0000-0000-0000-0001", public_pem=public_pem)
    head, payload, signature = issued.split(".")
    tampered = f"{head}.{payload}.{signature[:-2]}{'AA' if not signature.endswith('AA') else 'BB'}"
    return {
        "key": issued,
        "valid": ok["valid"],
        "reason": ok["reason"],
        "other_machine": other["reason"],
        "tampered": verify_key(tampered, public_pem=public_pem)["reason"],
        "matches_embedded_key": public_pem.strip() == PUBLIC_KEY_PEM.strip(),
    }
