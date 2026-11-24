"""Read-only MetaTrader 5 worker. UTF-8 NDJSON in/out; attaches to an already-authorized terminal only.

Run with Windows Python and the official MetaTrader5 module. The parent owns
HTTP delivery, sequencing and the watchdog (native tick reads have no timeout
argument). Closing stdin releases the Python attachment, not the terminal.
"""

import json
import math
import os
import re
import subprocess
import sys
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from importlib import import_module


MAX_LINE = 16 * 1024
MT5_TIMEOUT_MS = 15_000
POLL_LIMIT = 4_000
MAX_SECOND_OFFSET = 8_192
# A live cursor that stays empty while the terminal shows a newer quote is a broken stream, not a
# quiet market: report it after this many seconds instead of polling nothing forever.
TICK_STALL_SECONDS = 60
SYMBOL_CHART_MODE_BID = 0
SYMBOL_CHART_MODE_LAST = 1
TICK_FLAG_BID = 2
TICK_FLAG_LAST = 8
TICK_FLAG_BUY = 32
TICK_FLAG_SELL = 64
HISTORY_LIMIT = 100_000
HISTORY_LOOKBACK = 24 * 60 * 60
HISTORY_WINDOW = 30 * 60
HISTORY_MAX_READS = 64
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


_SYMBOL_INFO_NOT_READ = object()
_SYMBOL_INFO_FAILED = object()


def symbol_spec(api, symbol, info=_SYMBOL_INFO_NOT_READ):
    """The broker's own price grid for the symbol: (spec, None) or (None, reason).

    The caller may pass the result of its existing symbol_info call so connection
    setup does not query MT5 twice. The reason distinguishes a failed read, no
    metadata, and an unusable tick grid.
    """
    if info is _SYMBOL_INFO_NOT_READ:
        try:
            info = api.symbol_info(symbol)
        except Exception:
            return None, "symbol_info_failed"
    elif info is _SYMBOL_INFO_FAILED:
        return None, "symbol_info_failed"
    if info is None:
        return None, "symbol_info_empty"
    tick = getattr(info, "trade_tick_size", None)
    point = getattr(info, "point", None)
    size = tick if isinstance(tick, (int, float)) and tick > 0 else point
    if not isinstance(size, (int, float)) or not (0 < size <= 100) or size != size:
        return None, "tick_size_unusable"
    return {"tickSize": float(size)}, None


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
    flags = int(row["flags"])
    if chart_mode == SYMBOL_CHART_MODE_BID:
        # In Bid-chart mode MT5 builds OHLC strictly from Bid updates. An Ask-only tick
        # (flags == TICK_FLAG_ASK) carries the previous bar's Bid and would stamp the wrong
        # Open/High/Low at bar boundaries.
        if flags > 0 and (flags & (TICK_FLAG_BID | TICK_FLAG_LAST | TICK_FLAG_BUY | TICK_FLAG_SELL)) == 0:
            return None
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
        "flags": flags,
    }


def running_terminal_paths():
    """Return paths of MT5 terminals that are already running for this Windows user."""
    if os.name != "nt":
        raise WorkerError("terminal_discovery_unsupported",
                          "Автопоиск MetaTrader 5 доступен в Windows. Откройте MT5 и повторите подключение.")
    script = (
        "$ErrorActionPreference='Stop'; "
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; "
        "Get-CimInstance Win32_Process -Filter \"Name='terminal64.exe'\" | "
        "Where-Object { $_.ExecutablePath } | ForEach-Object { $_.ExecutablePath }"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=8, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    except Exception:
        raise WorkerError("terminal_discovery_failed",
                          "Не удалось найти запущенный MetaTrader 5. Откройте терминал и повторите.") from None
    if result.returncode != 0:
        raise WorkerError("terminal_discovery_failed",
                          "Windows не смогла определить путь к запущенному MetaTrader 5.")
    paths = []
    for line in result.stdout.splitlines():
        candidate = line.strip().strip('"')
        if candidate and os.path.basename(candidate).casefold() == "terminal64.exe" and os.path.isfile(candidate):
            paths.append(os.path.realpath(candidate))
    return paths


def choose_gold_symbol(api, requested=None):
    """Choose an exact/visible broker gold symbol; never substitute a non-gold instrument."""
    names = []
    try:
        symbols = api.symbols_get()
    except Exception:
        symbols = None
    for item in symbols or ():
        name = getattr(item, "name", "")
        if isinstance(name, str) and re.fullmatch(r"(?:XAUUSD|GOLD)[A-Z0-9._#+-]{0,20}", name, re.IGNORECASE):
            names.append((name, bool(getattr(item, "visible", False))))
    unique = {name.casefold(): (name, visible) for name, visible in names}
    candidates = list(unique.values())
    if requested:
        match = next((name for name, _ in candidates if name.casefold() == requested.casefold()), None)
        if match:
            return match
    # The active chart symbol is not exposed by the terminal discovery flow.
    # Choose only when Market Watch has exactly one visible gold instrument;
    # an exact-name preference can still silently select a different chart symbol.
    visible = [name for name, is_visible in candidates if is_visible]
    if len(visible) == 1:
        return visible[0]
    if len(visible) > 1 or len(candidates) > 1:
        raise WorkerError("ambiguous_gold_symbol",
                          "В MT5 найдено несколько инструментов золота. Оставьте видимым только нужный символ в «Обзоре рынка» и повторите подключение.")
    if len(candidates) == 1:
        return candidates[0][0]
    # Some older terminals only expose a symbol through symbol_info before it is in symbols_get().
    fallbacks = [requested] if requested else []
    fallbacks.extend(["XAUUSD", "GOLD"])
    for candidate in fallbacks:
        if candidate:
            try:
                if api.symbol_info(candidate) is not None:
                    return candidate
            except Exception:
                pass
    raise WorkerError("gold_symbol_not_found",
                      "В авторизованном MT5 не найден XAUUSD или GOLD. Добавьте инструмент золота в «Обзор рынка».")


class Worker:
    def __init__(self, load_api=None, terminal_finder=None):
        self.load_api = load_api or (lambda: import_module("MetaTrader5"))
        self.find_terminals = terminal_finder or running_terminal_paths
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
        requested_symbol = text(command, "symbol", 128, optional=True)
        try:
            paths = self.find_terminals()
        except WorkerError:
            raise
        except Exception:
            raise WorkerError("terminal_discovery_failed", "Не удалось найти уже запущенный MetaTrader 5.") from None
        if not paths:
            raise WorkerError("terminal_not_running", "Не найден запущенный MetaTrader 5. Откройте MT5, войдите в счёт обычным способом и повторите подключение.")
        if len(paths) != 1:
            raise WorkerError("multiple_terminal_instances",
                              "Найдено несколько запущенных терминалов MT5. Оставьте открытым нужный терминал с авторизованным счётом и повторите подключение.")
        terminal_path = paths[0]
        if not isinstance(terminal_path, str) or os.path.basename(terminal_path).casefold() != "terminal64.exe":
            raise WorkerError("terminal_path_invalid", "Windows вернула некорректный путь к terminal64.exe.")
        try:
            if self.api is None:
                try:
                    self.api = self.load_api()
                except Exception:
                    raise WorkerError("mt5_module_unavailable", "The MetaTrader5 Python module could not load. Check the app's Windows Python runtime.") from None
            try:
                initialized = self.api.initialize(terminal_path, timeout=MT5_TIMEOUT_MS)
            except Exception:
                initialized = False
            if not initialized:
                hint = journal_hint()
                raise mt5_error(self.api, "initialize_failed", "Не удалось подключиться к уже открытому MT5." + (f" {hint}" if hint else
                    " Проверьте, что терминал не закрыт и полностью загрузился. GOLD-3Po не будет выполнять вход в счёт самостоятельно."))
            terminal = self.api.terminal_info()
            if terminal is None:
                raise mt5_error(self.api, "terminal_unavailable", "MT5 не подтвердил данные терминала.")
            actual = os.path.normcase(os.path.realpath(terminal.path))
            expected = os.path.dirname(os.path.normcase(os.path.realpath(terminal_path)))
            if actual != expected:
                raise WorkerError("terminal_mismatch", "MT5 подключил не тот запущенный терминал. Закройте лишние экземпляры и повторите.")
            if not terminal.connected:
                raise WorkerError("terminal_not_authorized", "Терминал MT5 открыт, но не подключён к брокеру. Сначала войдите в счёт в самом MT5.")
            account = self.api.account_info()
            if account is None or not getattr(account, "login", 0) or not getattr(account, "server", ""):
                raise WorkerError("terminal_not_authorized", "В MT5 нет подтверждённого авторизованного счёта. Войдите в него в самом терминале.")
            login = int(account.login)
            server = plain(str(account.server), 128)
            symbol = choose_gold_symbol(self.api, requested_symbol)
            if not self.api.symbol_select(symbol, True):
                raise mt5_error(self.api, "symbol_select_failed", "MT5 не смог выбрать найденный инструмент золота из «Обзора рынка».")
            # The session can still stream broker quotes when MT5 does not expose
            # symbol metadata. Keep the connection and report the missing tick grid
            # separately through specUnavailable below.
            try:
                symbol_info = self.api.symbol_info(symbol)
            except Exception:
                symbol_info = _SYMBOL_INFO_FAILED
            chart_mode = getattr(symbol_info, "chart_mode", None) if symbol_info not in (None, _SYMBOL_INFO_FAILED) else None
            # RoboForex spot gold is OTC; MT5's standard chart is Bid. Midpoint fallback shifts all OHLC values.
            self.chart_mode = chart_mode if chart_mode in (SYMBOL_CHART_MODE_BID, SYMBOL_CHART_MODE_LAST) else SYMBOL_CHART_MODE_BID
            for path in (terminal.commondata_path, terminal.data_path):
                if not isinstance(path, str) or not path or len(path) > 4096:
                    raise WorkerError("terminal_paths_unavailable", "MT5 did not provide its terminal data directories.")

            # Attach to the account already authenticated inside MT5. No login() call
            # is made, no account password is requested and the active account is not changed.
            latest = self.api.symbol_info_tick(symbol)
            latest_ms = (latest.time_msc or latest.time * 1000) if latest is not None else 0
            boundary = latest_ms // 1000 if latest_ms > 0 else int(datetime.now(timezone.utc).timestamp())
            self.verify(login, server)
            self.session = (login, server, symbol, boundary)
            self.cursor = (boundary, 0)
            result = {
                "symbol": symbol, "commonDataPath": terminal.commondata_path,
                "dataPath": terminal.data_path, "terminalPath": terminal_path,
                "accountLogin": str(login), "server": server,
                # Everything downstream (history window, live cursor) is anchored to the terminal's last
                # tick, so the caller must be able to say how old that anchor is.
                "lastTickAt": (EPOCH + timedelta(milliseconds=latest_ms)).isoformat(timespec="seconds").replace("+00:00", "Z") if latest_ms else None,
                "tickAgeMs": max(0, int(datetime.now(timezone.utc).timestamp() * 1000) - latest_ms) if latest_ms else None
            }
            spec, missing = symbol_spec(self.api, symbol, symbol_info)
            if spec:
                result["spec"] = spec
            else:
                result["specUnavailable"] = missing
            return result
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
        if not ticks:
            # An empty read is not "a quiet market" when the terminal itself carries a newer quote:
            # first retry from start + 1 in case MT5 stalled on the boundary second; only fail if
            # the terminal still returns nothing despite a newer quote.
            latest = self.api.symbol_info_tick(symbol)
            latest_ms = (latest.time_msc or latest.time * 1000) if latest is not None else 0
            if latest_ms // 1000 > start + TICK_STALL_SECONDS:
                retry_rows = self.read_ticks(symbol, start + 1, POLL_LIMIT)
                r_second, r_seen = start + 1, 0
                for row in retry_rows:
                    stamp = milliseconds(row)
                    row_second = stamp // 1000
                    if row_second < start + 1:
                        continue
                    if row_second != r_second:
                        r_second, r_seen = row_second, 0
                    r_seen += 1
                    tick = encode_tick(row, stamp, self.chart_mode)
                    if tick is not None:
                        ticks.append(tick)
                    if len(ticks) == POLL_LIMIT:
                        break
                if ticks:
                    self.cursor = (r_second, r_seen)
                    return {"connected": True, "ticks": ticks}
                stamp = (EPOCH + timedelta(milliseconds=latest_ms)).isoformat(timespec="seconds").replace("+00:00", "Z")
                raise WorkerError("tick_stream_missing",
                    f"Терминал отдаёт котировки (последний тик {stamp}), но чтение тиков от курсора возвращает пусто. Переподключите MT5 в приложении.")
        # MT5 starts inclusively at whole seconds; count rows in the boundary
        # second, including duplicates and unusable quotes, to avoid replay/gaps.
        if second > start or seen > offset:
            self.cursor = (second, seen)
        return {"connected": True, "ticks": ticks}

    def history(self):
        _, _, symbol, boundary = self.require_session()
        raw_start = max(0, boundary - HISTORY_LOOKBACK)
        # Align the lookback start to a whole hour boundary so the oldest M5/M15/M30/H1 candle is
        # never chopped in half and matches MT5's own bar Open/High/Low.
        start = (raw_start // 3600) * 3600
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
