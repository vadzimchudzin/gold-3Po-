"""Tests for the offline keygen core: signing rules shared with license.js."""

import json
import sys
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

sys.path.insert(0, str(Path(__file__).resolve().parent))

import keygen_core as core


def fresh_keypair():
    private_key = Ed25519PrivateKey.generate()
    public_pem = (
        private_key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")
    )
    return private_key, public_pem


class KeygenCoreTest(unittest.TestCase):
    def setUp(self):
        self.private_key, self.public_pem = fresh_keypair()

    def test_key_verifies_on_the_issued_machine(self):
        key = core.issue_key(self.private_key, "a8e4-1965-47c1-c929", 365, "pro")
        result = core.verify_key(key, "A8E4-1965-47C1-C929", public_pem=self.public_pem)
        self.assertTrue(result["valid"], result["reason"])
        self.assertEqual(result["payload"]["machine"], "A8E4196547C1C929")
        self.assertEqual(result["payload"]["days"], 365)
        self.assertEqual(result["payload"]["product"], "gold-3po")

    def test_payload_shape_matches_the_javascript_issuer(self):
        key = core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 30, "trial", key_id="abc123")
        encoded = key.split(".")[1]
        payload = json.loads(core.b64url_decode(encoded))
        # Key order matters: the signature covers the encoded string, and license.js writes the
        # same order, so a diff here means the two issuers are no longer interchangeable.
        self.assertEqual(
            list(payload),
            ["v", "product", "edition", "machine", "keyId", "issuedAt", "days", "expiresAt"],
        )
        self.assertEqual(payload["expiresAt"] - payload["issuedAt"], 30 * core.DAY_MS)

    def test_another_machine_is_rejected(self):
        key = core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 30, "pro")
        self.assertEqual(core.verify_key(key, "0000-0000-0000-0001", public_pem=self.public_pem)["reason"], "wrong_machine")

    def test_tampered_signature_is_rejected(self):
        key = core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 30, "pro")
        head, payload, signature = key.split(".")
        bent = signature[:-2] + ("AA" if not signature.endswith("AA") else "BB")
        self.assertEqual(core.verify_key(f"{head}.{payload}.{bent}", public_pem=self.public_pem)["reason"], "bad_signature")

    def test_a_key_from_another_pair_is_rejected(self):
        foreign_private, _ = fresh_keypair()
        key = core.issue_key(foreign_private, "A8E4-1965-47C1-C929", 30, "pro")
        self.assertEqual(core.verify_key(key, "A8E4-1965-47C1-C929", public_pem=self.public_pem)["reason"], "bad_signature")

    def test_expiry_and_clock_skew(self):
        key = core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 1, "pro")
        payload = core.verify_key(key, public_pem=self.public_pem)["payload"]
        after = payload["expiresAt"] + 1000
        self.assertEqual(core.verify_key(key, "A8E4-1965-47C1-C929", now_ms=after, public_pem=self.public_pem)["reason"], "expired")
        early = payload["issuedAt"] - 60 * 60 * 1000
        self.assertEqual(core.verify_key(key, "A8E4-1965-47C1-C929", now_ms=early, public_pem=self.public_pem)["reason"], "not_yet_valid")

    def test_truncated_key_is_malformed_not_silently_accepted(self):
        key = core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 30, "pro")
        self.assertEqual(core.verify_key(key[: len(key) // 2], public_pem=self.public_pem)["reason"], "malformed_key")

    def test_bad_machine_id_and_days_are_refused(self):
        with self.assertRaises(ValueError):
            core.issue_key(self.private_key, "A8E4-1965", 30, "pro")
        with self.assertRaises(ValueError):
            core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 0, "pro")
        with self.assertRaises(ValueError):
            core.issue_key(self.private_key, "A8E4-1965-47C1-C929", 30, "  ")

    def test_embedded_public_key_is_a_valid_ed25519_spki(self):
        loaded = serialization.load_pem_public_key(core.PUBLIC_KEY_PEM.encode("ascii"))
        self.assertIsInstance(loaded, Ed25519PublicKey)

    def test_selftest_signs_and_verifies(self):
        pem = self.private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ).decode("ascii")
        report = core.selftest(pem)
        self.assertTrue(report["valid"], report["reason"])
        self.assertEqual(report["other_machine"], "wrong_machine")
        self.assertEqual(report["tampered"], "bad_signature")


if __name__ == "__main__":
    unittest.main()
