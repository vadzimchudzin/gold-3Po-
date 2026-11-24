"""GOLD-3Po offline licence generator (Windows GUI).

A single-window tool the vendor can carry on a USB stick: it signs `GOLD1.…`
licence keys with the vendor Ed25519 key and keeps a journal of everything
issued. Signing happens locally; nothing is sent over the network.

The private key is read from `license-private.pem` next to the executable or
from a path chosen once and remembered in `keygen-config.json`.

The payload layout and encoding live in keygen_core.py and match license.js
byte for byte, so keys issued here are accepted by the app.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except Exception:  # a build without Tk can still run --selftest
    tk = filedialog = messagebox = ttk = None

from keygen_core import (
    JOURNAL_PATH,
    MAX_DAYS,
    MIN_DAYS,
    REASONS,
    find_private_key,
    issue_key,
    load_config,
    normalize_machine_id,
    read_private_key,
    save_config,
    verify_key,
)

Base = tk.Tk if tk is not None else object


class KeygenApp(Base):
    def __init__(self) -> None:
        if tk is None:
            raise SystemExit("Окно недоступно: в этой сборке нет Tk. Запустите GOLD3Po-Keygen.exe.")
        super().__init__()
        self.title("GOLD-3Po · генератор лицензий")
        self.geometry("760x580")
        self.minsize(680, 540)
        self.private_key_path: Path | None = None
        self.private_key = None
        self.last_key = ""
        self._build()
        self._load_key()

    # ---- layout -----------------------------------------------------------
    def _build(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass

        top = ttk.Frame(self)
        top.pack(fill="x", padx=12, pady=6)
        ttk.Label(top, text="Ключ подписи:", font=("Segoe UI", 10, "bold")).pack(side="left")
        self.key_state = ttk.Label(top, text="поиск…", foreground="#a06000")
        self.key_state.pack(side="left", padx=8)
        ttk.Button(top, text="Указать файл…", command=self.choose_key).pack(side="right")

        notebook = ttk.Notebook(self)
        notebook.pack(fill="both", expand=True, padx=12, pady=4)
        issue = ttk.Frame(notebook)
        check = ttk.Frame(notebook)
        notebook.add(issue, text="Выдать ключ")
        notebook.add(check, text="Проверить ключ")
        self._build_issue(issue)
        self._build_check(check)

        self.status = ttk.Label(self, text="", foreground="#0a6b2e")
        self.status.pack(fill="x", padx=12, pady=(0, 8))

    def _build_issue(self, parent: ttk.Frame) -> None:
        form = ttk.Frame(parent)
        form.pack(fill="x", padx=12, pady=12)
        form.columnconfigure(1, weight=1)

        ttk.Label(form, text="ID компьютера клиента").grid(row=0, column=0, sticky="w", pady=4)
        self.machine = tk.StringVar()
        ttk.Entry(form, textvariable=self.machine, font=("Consolas", 12)).grid(row=0, column=1, sticky="ew", padx=8)
        ttk.Label(form, text="с окна активации, вид A8E4-1965-47C1-C929", foreground="#666").grid(row=1, column=1, sticky="w", padx=8)

        ttk.Label(form, text="Срок, дней").grid(row=2, column=0, sticky="w", pady=4)
        self.days = tk.StringVar(value="365")
        ttk.Spinbox(form, from_=MIN_DAYS, to=MAX_DAYS, textvariable=self.days, width=10).grid(row=2, column=1, sticky="w", padx=8)

        ttk.Label(form, text="Издание").grid(row=3, column=0, sticky="w", pady=4)
        self.edition = tk.StringVar(value="pro")
        ttk.Combobox(form, textvariable=self.edition, values=("pro", "trial", "vip"), width=12).grid(row=3, column=1, sticky="w", padx=8)

        buttons = ttk.Frame(parent)
        buttons.pack(fill="x", padx=12)
        ttk.Button(buttons, text="Выдать ключ", command=self.issue).pack(side="left")
        ttk.Button(buttons, text="Сохранить в файл…", command=self.save_key).pack(side="left", padx=8)
        ttk.Button(buttons, text="Открыть журнал", command=self.open_journal).pack(side="left")

        self.result = tk.Text(parent, height=5, wrap="char", font=("Consolas", 9))
        self.result.pack(fill="both", expand=True, padx=12, pady=12)

    def _build_check(self, parent: ttk.Frame) -> None:
        ttk.Label(parent, text="Вставьте ключ и нажмите «Проверить»:", anchor="w").pack(fill="x", padx=12, pady=(12, 4))
        self.check_input = tk.Text(parent, height=5, wrap="char", font=("Consolas", 9))
        self.check_input.pack(fill="both", expand=True, padx=12)
        ttk.Button(parent, text="Проверить", command=self.check).pack(anchor="w", padx=12, pady=8)
        self.check_result = tk.Text(parent, height=8, wrap="word", font=("Segoe UI", 9), state="disabled", background="#f6f6f6")
        self.check_result.pack(fill="both", expand=True, padx=12, pady=(0, 12))

    # ---- key handling -----------------------------------------------------
    def _load_key(self) -> None:
        path = self.private_key_path or find_private_key()
        if not path:
            self.key_state.configure(text="не найден — положите license-private.pem рядом с программой", foreground="#b00020")
            return
        try:
            self.private_key = read_private_key(path)
            self.private_key_path = path
            self.key_state.configure(text=f"загружен: {path.name}  ({path.parent})", foreground="#0a6b2e")
        except Exception as error:
            self.private_key = None
            self.key_state.configure(text=f"не читается: {error}", foreground="#b00020")

    def choose_key(self) -> None:
        chosen = filedialog.askopenfilename(title="Файл приватного ключа", filetypes=[("PEM", "*.pem"), ("Все файлы", "*.*")])
        if not chosen:
            return
        try:
            self.private_key = read_private_key(Path(chosen))
        except Exception as error:
            messagebox.showerror("Ключ не подходит", f"{error}\n\nНужен файл license-private.pem (Ed25519, PKCS#8).")
            return
        self.private_key_path = Path(chosen)
        config = load_config()
        config["privateKeyPath"] = str(self.private_key_path)
        save_config(config)
        self._load_key()

    # ---- actions ---------------------------------------------------------
    def issue(self) -> None:
        if not self.private_key:
            messagebox.showerror("Нет ключа подписи", "Не найден license-private.pem. Без него выпустить лицензию невозможно.")
            return
        try:
            days = int(self.days.get().strip())
        except ValueError:
            messagebox.showerror("Срок", "Срок должен быть числом дней.")
            return
        try:
            key = issue_key(self.private_key, self.machine.get(), days, self.edition.get())
        except Exception as error:
            messagebox.showerror("Не получилось", str(error))
            return
        self.last_key = key
        self.result.delete("1.0", "end")
        self.result.insert("1.0", key)
        self.clipboard_clear()
        self.clipboard_append(key)
        self._journal(key)
        payload = verify_key(key)["payload"] or {}
        expires = datetime.fromtimestamp(payload.get("expiresAt", 0) / 1000, timezone.utc).astimezone().strftime("%d.%m.%Y")
        self.status.configure(text=f"Ключ выдан и скопирован в буфер · действует до {expires}", foreground="#0a6b2e")

    def save_key(self) -> None:
        if not self.last_key:
            messagebox.showinfo("Пусто", "Сначала выдайте ключ.")
            return
        target = filedialog.asksaveasfilename(defaultextension=".txt", initialfile=f"license-{normalize_machine_id(self.machine.get())}.txt")
        if not target:
            return
        Path(target).write_text(self.last_key + "\n", "utf-8")
        self.status.configure(text=f"Сохранено: {target}", foreground="#0a6b2e")

    def _journal(self, key: str) -> None:
        payload = verify_key(key)["payload"] or {}
        row = {
            "issuedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "machineId": payload.get("machine", ""),
            "edition": payload.get("edition", ""),
            "days": payload.get("days", ""),
            "expiresAt": datetime.fromtimestamp(payload.get("expiresAt", 0) / 1000, timezone.utc).astimezone().isoformat(timespec="seconds"),
            "keyId": payload.get("keyId", ""),
            "key": key,
        }
        fresh = not JOURNAL_PATH.exists()
        try:
            with JOURNAL_PATH.open("a", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(row))
                if fresh:
                    writer.writeheader()
                writer.writerow(row)
        except Exception as error:
            self.status.configure(text=f"Журнал не записался: {error}", foreground="#a06000")

    def open_journal(self) -> None:
        if not JOURNAL_PATH.exists():
            messagebox.showinfo("Журнал", "Пока ничего не выдано.")
            return
        if hasattr(os, "startfile"):
            os.startfile(JOURNAL_PATH)
        else:
            messagebox.showinfo("Журнал", str(JOURNAL_PATH))

    def check(self) -> None:
        candidate = self.check_input.get("1.0", "end").strip()
        result = verify_key(candidate, machine_id=self.machine.get().strip())
        payload = result["payload"] or {}
        lines = [REASONS.get(result["reason"], result["reason"])]
        if payload:
            expires = datetime.fromtimestamp(payload.get("expiresAt", 0) / 1000, timezone.utc).astimezone().strftime("%d.%m.%Y %H:%M")
            lines += [
                "",
                f"компьютер: {payload.get('machine', '')}",
                f"издание:   {payload.get('edition', '')}",
                f"срок:      {payload.get('days', '')} дн., до {expires}",
                f"keyId:     {payload.get('keyId', '')}",
            ]
        self.check_result.configure(state="normal")
        self.check_result.delete("1.0", "end")
        self.check_result.insert("1.0", "\n".join(lines))
        self.check_result.configure(state="disabled")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        from keygen_core import selftest

        pem = Path(sys.argv[2]).read_text("utf-8") if len(sys.argv) > 2 else sys.stdin.read()
        report = json.dumps(selftest(pem), ensure_ascii=False)
        if len(sys.argv) > 3:
            # The packaged binary is windowed, so it has no usable stdout: write the report instead.
            Path(sys.argv[3]).write_text(report, "utf-8")
        else:
            print(report)
        return
    KeygenApp().mainloop()


if __name__ == "__main__":
    main()
