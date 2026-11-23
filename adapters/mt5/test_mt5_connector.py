"""Run with python -B -m unittest discover -s adapters/mt5 -p test_mt5_connector.py."""

import io
import json
import os
import unittest
from datetime import timezone
from types import SimpleNamespace
from unittest.mock import patch

import mt5_connector as connector


SECOND = 1_700_000_000
SECRET = " read-only test password "


def tick(second, millis=0, **changes):
    return {"time": second, "time_msc": second * 1000 + millis,
            "bid": 2000.0, "ask": 2000.5, "last": 0.0, "volume": 7,
            "volume_real": 0.0, "flags": 6, **changes}


class FakeMT5:
    COPY_TICKS_ALL = -1

    def __init__(self):
        self.install = os.path.abspath("Some MT5")
        self.terminal = SimpleNamespace(connected=True, path=self.install,
                                        data_path="terminal data", commondata_path="common data")
        self.account = SimpleNamespace(login=1234, server="Broker-Demo", trade_allowed=False)
        self.latest = SimpleNamespace(time=SECOND, time_msc=SECOND * 1000 + 800)
        self.info = SimpleNamespace(chart_mode=connector.SYMBOL_CHART_MODE_BID)
        self.rows = [tick(SECOND, 800)]
        self.calls = []
        self.login_ok = True
        self.select_ok = True
        self.copy_error = False

    def initialize(self, *args, timeout):
        self.calls.append(("initialize", args, timeout))
        return True

    def login(self, number, *, password, server, timeout):
        self.calls.append(("login", number, password, server, timeout))
        return self.login_ok

    def shutdown(self):
        self.calls.append(("shutdown",))

    def terminal_info(self):
        return self.terminal

    def account_info(self):
        return self.account

    def symbol_info_tick(self, symbol):
        return self.latest

    def symbol_info(self, symbol):
        self.calls.append(("symbol_info", symbol))
        return self.info

    def symbol_select(self, symbol, enabled):
        self.calls.append(("symbol_select", symbol, enabled))
        return self.select_ok

    def last_error(self):
        return -6, f"Sensitive API diagnostic: {SECRET}"

    def copy_ticks_from(self, symbol, timestamp, limit, flags):
        self.calls.append(("copy_ticks_from", symbol, timestamp, limit, flags))
        if self.copy_error:
            return None
        start = int(timestamp.timestamp())
        return [row for row in self.rows if row["time"] >= start][:limit]


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeMT5()
        self.worker = connector.Worker(lambda: self.api)
        self.addCleanup(self.worker.close)

    def command(self, op, **fields):
        line = json.dumps({"id": "request-1", "op": op, **fields}).encode() + b"\n"
        return connector.handle_line(self.worker, line)

    def connect(self, **fields):
        return self.command("connect", **{"terminalPath": os.path.join(self.api.install, "terminal64.exe"),
                                           "login": "1234", "password": SECRET, "server": "Broker-Demo",
                                           "symbol": "XAUUSDm", **fields})

    def test_connect_investor_account_and_exact_suffix(self):
        self.assertEqual(self.connect(), {"id": "request-1", "ok": True, "symbol": "XAUUSDm",
                                         "commonDataPath": "common data", "dataPath": "terminal data"})
        self.assertEqual(self.api.calls, [
            ("initialize", (os.path.join(self.api.install, "terminal64.exe"),), connector.MT5_TIMEOUT_MS),
            ("login", 1234, SECRET, "Broker-Demo", connector.MT5_TIMEOUT_MS),
            ("symbol_select", "XAUUSDm", True),
            ("symbol_info", "XAUUSDm"),
        ])

    def test_auto_discover_and_clean_failure(self):
        self.api.login_ok = False
        result = self.connect(terminalPath=None)
        self.assertEqual(self.api.calls[0], ("initialize", (), connector.MT5_TIMEOUT_MS))
        self.assertEqual(result["error"], "login_failed")
        self.assertEqual(result["mt5Code"], -6)
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertEqual(self.command("poll")["error"], "not_connected")

    def test_wrong_terminal_does_not_receive_login(self):
        self.api.terminal.path = os.path.abspath("Other terminal")
        self.assertEqual(self.connect()["error"], "terminal_mismatch")
        self.assertNotIn("login", [call[0] for call in self.api.calls])

    def test_requires_confirmed_account_and_symbol(self):
        self.api.account.login = 9876
        self.assertEqual(self.connect()["error"], "account_mismatch")
        self.api.account.login = 1234
        self.api.select_ok = False
        self.assertEqual(self.connect()["error"], "symbol_select_failed")
        self.assertEqual(self.command("history")["error"], "not_connected")

    def test_live_poll_utc_midpoint_and_duplicate_boundary(self):
        self.api.rows = [tick(SECOND, 799), tick(SECOND, 799), tick(SECOND, 800, bid=0.0),
                         tick(SECOND, 801), tick(SECOND + 1, 20, last=2000.4, volume_real=0.7, flags=32)]
        self.assertTrue(self.connect()["ok"])
        with patch.object(connector, "POLL_LIMIT", 2):
            first, second, third, fourth = (self.command("poll") for _ in range(4))
        self.assertTrue(first["connected"])
        self.assertEqual(len(first["ticks"]), 2)
        self.assertEqual(first["ticks"][0], {"timestamp": "2023-11-14T22:13:20.799Z", "bid": 2000.0,
                                            "ask": 2000.5, "last": 2000.0, "tickVolume": 7,
                                            "realVolume": 0.0, "flags": 6})
        self.assertEqual(first["ticks"][0], first["ticks"][1])
        self.assertEqual([row["last"] for row in second["ticks"] + third["ticks"]], [2000.0, 2000.0])
        self.assertEqual(third["ticks"][0]["realVolume"], 0.7)
        self.assertEqual(fourth["ticks"], [])
        reads = [call for call in self.api.calls if call[0] == "copy_ticks_from"]
        self.assertTrue(all(call[2].tzinfo is timezone.utc and call[4] == -1 for call in reads))

    def test_chart_mode_uses_bid_or_last_price_like_the_mt5_chart(self):
        quote = tick(SECOND, 900, bid=2000.0, ask=2000.5, last=0.0)
        bid_bar = connector.encode_tick(quote, SECOND * 1000 + 900, connector.SYMBOL_CHART_MODE_BID)
        last_fallback = connector.encode_tick(quote, SECOND * 1000 + 900, connector.SYMBOL_CHART_MODE_LAST)
        last_trade = connector.encode_tick({**quote, "last": 2000.42}, SECOND * 1000 + 900,
                                            connector.SYMBOL_CHART_MODE_LAST)
        self.assertEqual(bid_bar["last"], 2000.0)
        self.assertEqual(last_fallback["last"], 2000.25)
        self.assertEqual(last_trade["last"], 2000.42)

    def test_disconnected_terminal_mismatch_and_read_diagnostics(self):
        self.connect()
        self.api.terminal.connected = False
        self.assertEqual(self.command("poll")["error"], "terminal_disconnected")
        self.api.terminal.connected = True
        self.api.copy_error = True
        self.assertEqual(self.command("poll")["error"], "tick_read_failed")
        self.api.account.server = "Wrong server"
        self.assertEqual(self.command("poll")["error"], "account_mismatch")
        self.api.account.server = "Broker-Demo"
        self.assertEqual(self.command("poll")["error"], "not_connected")

    def test_history_excludes_live_cutoff_and_prioritizes_latest_under_cap(self):
        self.api.rows = [tick(SECOND + offset) for offset in (-9, -6, -5, -4, -3, -2, -1, 0, 1)]
        self.connect()
        with patch.multiple(connector, HISTORY_LIMIT=4, HISTORY_WINDOW=8, HISTORY_LOOKBACK=12):
            history = self.command("history")
        self.assertTrue(history["ok"])
        self.assertTrue(history["truncated"])
        self.assertEqual([item["timestamp"] for item in history["ticks"]],
                         ["2023-11-14T22:13:16.000Z", "2023-11-14T22:13:17.000Z",
                          "2023-11-14T22:13:18.000Z", "2023-11-14T22:13:19.000Z"])
        self.assertEqual(len(self.command("poll")["ticks"]), 2)
        reads = [call for call in self.api.calls if call[0] == "copy_ticks_from"][:-1]
        self.assertLessEqual(len(reads), connector.HISTORY_MAX_READS)
        self.assertTrue(all(call[3] <= 5 for call in reads))

    def test_ndjson_recovers_after_malformed_and_oversized_records(self):
        source = io.BytesIO(b'{invalid}\r\n' + b'x' * (connector.MAX_LINE * 2) + b'\n'
                            + b'{"id":2,"op":"poll"}\n{"id":" 1 ","op":"unknown"}\n')
        output = io.BytesIO()
        connector.serve(source, output, self.worker)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item["id"] for item in lines], [None, None, 2, " 1 "])
        self.assertEqual([item["error"] for item in lines],
                         ["invalid_json", "command_too_large", "not_connected", "unknown_operation"])

    def test_unexpected_library_exception_does_not_disclose_its_text(self):
        self.connect()
        with patch.object(self.api, "copy_ticks_from", side_effect=RuntimeError(SECRET)):
            result = self.command("poll")
        self.assertEqual(result["error"], "mt5_worker_error")
        self.assertNotIn(SECRET, json.dumps(result))


if __name__ == "__main__":
    unittest.main()
