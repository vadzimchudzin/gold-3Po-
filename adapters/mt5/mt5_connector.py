"""Read-only MetaTrader 5 worker. UTF-8 NDJSON in/out; credentials in stdin only.

Run with Windows Python and the official MetaTrader5 module. The parent owns
HTTP delivery, sequencing and the watchdog (native tick reads have no timeout
argument). Closing stdin releases the Python attachment, not the terminal.
"""

import json
import math
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from importlib import import_module


MAX_LINE = 16 * 1024
MT5_TIMEOUT_MS = 15_000
POLL_LIMIT = 1_000
MAX_SECOND_OFFSET = 8_192
SYMBOL_CHART_MODE_BID = 0
SYMBOL_CHART_MODE_LAST = 1
HISTORY_LIMIT = 25_000
HISTORY_LOOKBACK = 8 * 60 * 60
HISTORY_WINDOW = 30 * 60
HISTORY_MAX_READS = 24
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class WorkerError(Exception):
    def __init__(self, code, message, mt5_code=None):
        super().__init__(message)
        self.code = code
        self.mt5_code = mt5_code


TERMINAL_LOGS = os.path.join("%APPDATA%", "MetaQuotes", "Terminal")
# «0 14:22:33 '68533333': authorization on MEXIntGroup-Demo failed (Invalid account)»
AUTH_FAILED = re.compile(r"'(\d{1,20})':\s+authorization on (\S+) failed(?:\s*\(([^)]{0,160})\))?")
NO_DEMO_GROUPS = re.compile(r"no demo/preliminary groups on server side")


def plain(value, limit):
    """External text becomes a short printable fragment: no controls, no surprises in the window."""
    value = "".join(ch if ch.isprintable() else " " for ch in value)
    return " ".join(value.split())[:limit]


def journal_text(data):
    """Journal files are UTF-8 or the system code page, and a BOM is the only hint that one is UTF-16."""
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace")
    if data.count(0) > len(data) // 4:
        return data.decode("utf-16-le", "replace")
    for encoding in ("utf-8", "cp1251"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", "replace")


def journal_lines(root=None, keep=80):
    """Tail of the journal the running MT5 terminal writes, newest file first."""
    root = root or os.path.expandvars(TERMINAL_LOGS)
    files = []
    try:
        for name in os.listdir(root):
            folder = os.path.join(root, name, "logs")
            if not os.path.isdir(folder):
                continue
            for entry in os.listdir(folder):
                if entry.lower().endswith(".log"):
                    files.append(os.path.join(folder, entry))
        if not files:
            return []
        newest = max(files, key=os.path.getmtime)
        with open(newest, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 32_768))
            data = handle.read()
    except OSError:
        return []
    return [line.strip() for line in journal_text(data).splitlines() if line.strip()][-keep:]


def journal_hint(root=None):
    """Why MT5 itself could not get in, said in our own words.

    The terminal logs the real reason — «'68533333': authorization on MEXIntGroup-Demo failed
    (Invalid account)» — while initialize() can only report «IPC timeout». Without this the window
    sends the user to check the executable path, which is never what is wrong when an account is
    simply not accepted by the broker.
    """
    account = server = why = ""
    no_demo = False
    for line in reversed(journal_lines(root)):
        found = AUTH_FAILED.search(line)
        if found and not account:
            account, server, why = found.group(1), plain(found.group(2), 64), plain(found.group(3) or "", 80)
        if NO_DEMO_GROUPS.search(line):
            no_demo = True
        if account and no_demo:
            break
    if account:
        reason = f" ({why})" if why else ""
        return (f"MT5 rejected the login: account {account} is not authorized on {server}{reason}."
                " Open MT5, log in to that account by hand, then connect again.")
    if no_demo:
        return ("The broker server has no demo groups, so this account cannot be opened there."
                " Check the server name in MT5, then connect again.")
    return ""


def mt5_error(api, code, message):
    # Do not forward the API's error text: only fixed messages and known codes.
    try:
        status = api.last_error()[0]
    except Exception:
        status = None
    if type(status) is int and (status in range(-8, 0) or status in range(-10005, -9999)):
        return WorkerError(code, f"{message} (MT5 code {status}.)", status)
    return WorkerError(code, message)


def text(command, field, limit, *, optional=False, strip=True):
    value = command.get(field)
    if optional and value is None:
        return ""
    if type(value) is str and len(value) <= limit:
        # Reject NUL (C-string truncation) and unpaired UTF-16 surrogates.
        if not re.search(r"[\x00\ud800-\udfff]", value):
            value = value.strip() if strip else value
            if optional or value:
                return value
    raise WorkerError("invalid_command", f"Provide a valid {field}.")


def account_number(value):
    if type(value) is str and re.fullmatch(r"[0-9]{1,20}", value):
        value = int(value)
    if type(value) is not int or not 0 < value < 2**64:
        raise WorkerError("invalid_command", "Provide a positive MT5 account number.")
    return value


def milliseconds(row):
    try:
        return int(row["time_msc"]) or int(row["time"]) * 1000
    except (KeyError, ValueError, IndexError, TypeError):
        return int(row["time"]) * 1000


def encode_tick(row, stamp, chart_mode=None):
    bid, ask, last = (float(row[name]) for name in ("bid", "ask", "last"))
    volume = int(row["volume"])
    real_volume = float(row["volume_real"])
    if (stamp <= 0 or not all(map(math.isfinite, (bid, ask, real_volume)))
            or bid <= 0 or ask < bid or volume < 0 or real_volume < 0):
        return None  # e.g. broker sent an empty quote; the ingest API rejects it.
    if chart_mode == SYMBOL_CHART_MODE_BID:
        # Most OTC/Forex MT5 charts are built from Bid. Do not plot the Bid/Ask
        # midpoint as candle price: that shifts every bar by half the spread.
        last = bid
    elif not math.isfinite(last) or last <= 0:
        # For Last-mode symbols use the broker's Last when present. If this
        # tick has no Last, retain the established quote-midpoint fallback.
        last = bid + (ask - bid) / 2
    return {
        "timestamp": (EPOCH + timedelta(milliseconds=stamp)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "bid": bid,
        "ask": ask,
        "last": last,
        "tickVolume": volume,
        "realVolume": real_volume,
        "flags": int(row["flags"]),
    }


class Worker:
    def __init__(self, load_api=None):
        self.load_api = load_api or (lambda: import_module("MetaTrader5"))
        self.api = None
        self.session = None
        self.chart_mode = None

    def close(self):
        self.session = None
        self.chart_mode = None
        if self.api is not None:
            try:
                self.api.shutdown()
            except Exception:
                pass

    def verify(self, login, server):
        terminal = self.api.terminal_info()
        if terminal is None:
            raise mt5_error(self.api, "terminal_unavailable", "Cannot read MT5 terminal status. Reconnect the terminal.")
        if not terminal.connected:
            raise WorkerError("terminal_disconnected", "MT5 is not connected to its broker server.")
        account = self.api.account_info()
        if account is None:
            raise mt5_error(self.api, "account_unavailable", "MT5 did not confirm a logged-in account.")
        if account.login != login or account.server.casefold() != server.casefold():
            raise WorkerError("account_mismatch", "The active MT5 account or server does not match. Reconnect the intended account.")
        return terminal

    def connect(self, command):
        self.close()
        terminal_path = text(command, "terminalPath", 4096, optional=True)
        login = account_number(command.get("login"))
        password = text(command, "password", 1024, strip=False)
        server = text(command, "server", 256)
        symbol = text(command, "symbol", 128)
        if terminal_path and not os.path.isfile(terminal_path):
            raise WorkerError("terminal_path_missing", "The MT5 terminal executable is not at that path. Choose terminal64.exe in the MT5 folder.")
        try:
            if self.api is None:
                try:
                    self.api = self.load_api()
                except Exception:
                    raise WorkerError("mt5_module_unavailable", "The MetaTrader5 Python module could not load. Check the app's Windows Python runtime.") from None
            try:
                initialized = self.api.initialize(*([terminal_path] if terminal_path else []), timeout=MT5_TIMEOUT_MS)
            except Exception:
                initialized = False
            if not initialized:
                hint = journal_hint()
                raise mt5_error(self.api, "initialize_failed", "Could not attach to MT5." + (f" {hint}" if hint else
                    " Open MT5 by hand, log in, wait for quotes, then connect again."))
            if terminal_path:
                terminal = self.api.terminal_info()
                if terminal is None:
                    raise mt5_error(self.api, "terminal_unavailable", "Cannot confirm the MT5 terminal installation.")
                # terminal_info().path is the installation directory, not the exe.
                actual = os.path.normcase(os.path.realpath(terminal.path))
                expected = os.path.dirname(os.path.normcase(os.path.realpath(terminal_path)))
                if actual != expected:
                    raise WorkerError("terminal_mismatch", "MT5 attached to a different terminal installation. Check the terminal executable path.")
            try:
                authenticated = self.api.login(login, password=password, server=server, timeout=MT5_TIMEOUT_MS)
            except Exception:
                authenticated = False
            if not authenticated:
                raise mt5_error(self.api, "login_failed", "MT5 login failed. Check the account number, password, broker server and network connection.")

            terminal = self.verify(login, server)
            if not self.api.symbol_select(symbol, True):
                raise mt5_error(self.api, "symbol_select_failed", "MT5 could not select the symbol. Use the exact Market Watch name, including its broker suffix and letter case.")
            symbol_info = self.api.symbol_info(symbol)
            if symbol_info is None:
                raise mt5_error(self.api, "symbol_info_failed", "MT5 could not read the selected symbol specification.")
            chart_mode = getattr(symbol_info, "chart_mode", None)
            self.chart_mode = chart_mode if chart_mode in (SYMBOL_CHART_MODE_BID, SYMBOL_CHART_MODE_LAST) else None
            for path in (terminal.commondata_path, terminal.data_path):
                if not isinstance(path, str) or not path or len(path) > 4096:
                    raise WorkerError("terminal_paths_unavailable", "MT5 did not provide its terminal data directories.")

            # Start at the latest broker second so quiet/closed markets and local
            # clock differences do not prevent the first quote from being read.
            latest = self.api.symbol_info_tick(symbol)
            latest_ms = (latest.time_msc or latest.time * 1000) if latest is not None else 0
            boundary = latest_ms // 1000 if latest_ms > 0 else int(datetime.now(timezone.utc).timestamp())
            self.verify(login, server)
            self.session = (login, server, symbol, boundary)
            self.cursor = (boundary, 0)
            return {"symbol": symbol, "commonDataPath": terminal.commondata_path, "dataPath": terminal.data_path}
        except Exception:
            self.close()
            raise

    def require_session(self):
        if self.session is None:
            raise WorkerError("not_connected", "No MT5 session. Connect to a terminal and account first.")
        login, server, _, _ = self.session
        try:
            self.verify(login, server)
        except WorkerError as exc:
            # A manually changed account must never resume the old cursor.
            if exc.code == "account_mismatch":
                self.close()
            raise
        return self.session

    def read_ticks(self, symbol, start, count):
        rows = self.api.copy_ticks_from(symbol, EPOCH + timedelta(seconds=start), count, self.api.COPY_TICKS_ALL)
        if rows is None:
            raise mt5_error(self.api, "tick_read_failed", "MT5 could not read broker ticks. Check the terminal connection and whether the symbol has tick data.")
        return rows

    def poll(self):
        _, _, symbol, _ = self.require_session()
        start, offset = self.cursor
        if offset > MAX_SECOND_OFFSET:
            raise WorkerError("poll_cursor_limit", "Too many ticks share the same broker second to continue safely. Reconnect to reset the live cursor.")
        rows = self.read_ticks(symbol, start, POLL_LIMIT + offset)
        ticks = []
        second, seen = start, 0
        for row in rows:
            stamp = milliseconds(row)
            row_second = stamp // 1000
            if row_second < start:
                continue
            if row_second != second:
                second, seen = row_second, 0
            seen += 1
            if second == start and seen <= offset:
                continue
            tick = encode_tick(row, stamp, self.chart_mode)
            if tick is not None:
                ticks.append(tick)
            if len(ticks) == POLL_LIMIT:
                break
        self.require_session()
        # MT5 starts inclusively at whole seconds; count rows in the boundary
        # second, including duplicates and unusable quotes, to avoid replay/gaps.
        if second > start or seen > offset:
            self.cursor = (second, seen)
        return {"connected": True, "ticks": ticks}

    def history(self):
        _, _, symbol, boundary = self.require_session()
        start = max(0, boundary - HISTORY_LOOKBACK)
        end = boundary
        windows = []
        while end > start:
            left = max(start, end - HISTORY_WINDOW)
            windows.append((left, end))
            end = left
        windows.reverse()

        # Most recent first, then reverse batches for chronological output. Use
        # a count-bounded read instead of copy_ticks_range, whose result size
        # has no cap. If dense data saturates a window, try its newer half first.
        batches, remaining = [], HISTORY_LIMIT
        for _ in range(HISTORY_MAX_READS):
            if not windows or not remaining:
                break
            left, right = windows.pop()
            rows = self.read_ticks(symbol, left, remaining + 1)
            items = [(milliseconds(row), row) for row in rows]
            items = [(stamp, row) for stamp, row in items if left * 1000 <= stamp < right * 1000]
            if len(items) > remaining and right - left > 1:
                mid = (left + right) // 2
                windows.extend(((left, mid), (mid, right)))
                continue
            batch = []
            for stamp, row in items:
                tick = encode_tick(row, stamp, self.chart_mode)
                if tick is not None:
                    batch.append(tick)
            if len(items) > remaining:
                # A pathological sub-second burst: cannot page inside the second.
                windows.append((left, right))
                batches.append(batch[-remaining:])
                break
            batches.append(batch)
            remaining -= len(batch)

        self.require_session()
        return {"connected": True, "truncated": bool(windows), "ticks": [tick for batch in reversed(batches) for tick in batch]}

    def dispatch(self, command):
        op = command.get("op")
        if op == "connect":
            return self.connect(command)
        if op == "poll":
            return self.poll()
        if op == "history":
            return self.history()
        raise WorkerError("unknown_operation", "Supported MT5 operations are connect, poll and history.")


def reject_constant(_):
    raise ValueError("Non-finite JSON value")


def handle_line(worker, line):
    request_id = None
    try:
        if len(line) > MAX_LINE:
            raise WorkerError("command_too_large", "MT5 commands must fit in 16 KiB including the newline.")
        try:
            command = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
        except (UnicodeError, ValueError, RecursionError):
            raise WorkerError("invalid_json", "Expected one UTF-8 JSON command per line.") from None
        if not isinstance(command, dict):
            raise WorkerError("invalid_command", "Expected an MT5 command object.")
        value = command.get("id")
        if not (type(value) is int and abs(value) < 2**53 or
                type(value) is str and 0 < len(value) <= 128):
            raise WorkerError("invalid_id", "Command id must be a short string or a safe integer.")
        request_id = value
        return {"id": request_id, "ok": True, **worker.dispatch(command)}
    except WorkerError as exc:
        response = {"id": request_id, "ok": False, "connected": False, "error": exc.code, "message": str(exc)}
        if exc.mt5_code is not None:
            response["mt5Code"] = exc.mt5_code
        return response
    except Exception:
        # Never echo a command, native exception text, or traceback.
        return {"id": request_id, "ok": False, "connected": False, "error": "mt5_worker_error",
                "message": "An unexpected MT5 error occurred. Check the terminal and try reconnecting."}


def serve(input_stream, output_stream, worker):
    try:
        while True:
            line = input_stream.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE and not line.endswith(b"\n"):
                # Drain the rest of this frame without buffering it or accepting
                # its continuation as a new command. Replies remain in order.
                while True:
                    rest = input_stream.readline(MAX_LINE + 1)
                    if not rest or rest.endswith(b"\n"):
                        break
            response = handle_line(worker, line)
            result = json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
            output_stream.write(result.encode("ascii") + b"\n")
            output_stream.flush()
    finally:
        worker.close()


def main():
    input_stream, output_stream = sys.stdin.buffer, sys.stdout.buffer
    with open(os.devnull, "w") as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
        try:
            serve(input_stream, output_stream, Worker())
        except (OSError, KeyboardInterrupt):
            pass  # parent closed its pipes or requested shutdown


def selftest():
    """The shipped message is what tells an engineer why MT5 would not attach: keep it checked."""
    import tempfile
    body = ("0\t10:00:04\tMEXIntGroup-Demo: no demo/preliminary groups on server side\n"
            "0\t10:00:05\t'68533333': authorization on MEXIntGroup-Demo failed (Invalid account)\n")
    for encoding in ("utf-8", "cp1251", "utf-16", "utf-16-le"):
        root = os.path.join(tempfile.mkdtemp(), "Terminal")
        os.makedirs(os.path.join(root, "ABC", "logs"))
        with open(os.path.join(root, "ABC", "logs", "20261120.log"), "wb") as handle:
            handle.write(body.encode(encoding))
        hint = journal_hint(root)
        assert "68533333" in hint and "MEXIntGroup-Demo" in hint and "Invalid account" in hint, (encoding, hint)
    assert journal_hint(os.path.join(tempfile.mkdtemp(), "none")) == ""
    print("selftest: ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
    else:
        main()
