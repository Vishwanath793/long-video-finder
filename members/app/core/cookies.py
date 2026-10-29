"""Validate a Netscape-format cookies.txt without ever reading values into logs.

Only cookie *names*, domains and expiry times are inspected; values are discarded while parsing.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .paths import expand

HEADER_PREFIXES = ("# Netscape HTTP Cookie File", "# HTTP Cookie File")
# Any of these on a youtube.com domain means the export came from a signed-in session.
LOGIN_COOKIES = ("SID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO", "SAPISID", "__Secure-3PAPISID")
STALE_FILE_DAYS = 30

EXPORT_HINT = ("Export it with the 'Get cookies.txt LOCALLY' extension while on youtube.com, "
               "signed in with your member account.")


@dataclass
class _Entry:
    domain: str
    name: str
    expires: int  # 0 = session cookie


@dataclass
class CookieReport:
    path: Path | None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)
    youtube_cookies: int = 0
    login_cookies: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def lines(self) -> list[tuple[str, str]]:
        """(level, text) pairs for display: level is 'error', 'warning' or 'info'."""
        return ([("error", e) for e in self.errors] + [("warning", w) for w in self.warnings]
                + [("info", i) for i in self.info])


def resolve_cookie_path(path: str | Path) -> tuple[Path | None, list[str]]:
    """Find the file the user meant, including the hidden-extension 'cookies.txt.txt' mistake."""
    p = expand(path)
    notes: list[str] = []
    if p.is_dir():
        for name in ("cookies.txt", "cookies.txt.txt"):
            if (p / name).is_file():
                p = p / name
                break
    if p.is_file():
        if p.name.lower().endswith(".txt.txt"):
            notes.append(f"The file is named '{p.name}' (Windows hid the extension). It works, "
                         "but consider renaming it to 'cookies.txt'.")
        return p, notes
    for alt in (p.with_name(p.name + ".txt"), p.with_name(p.name + ".txt.txt")):
        if alt.is_file():
            notes.append(f"'{p.name}' not found, but '{alt.name}' exists (Windows hides the .txt extension). "
                         "Using it - consider renaming it to 'cookies.txt'.")
            return alt, notes
    return None, notes


def _parse(text: str) -> tuple[bool, list[_Entry], int, bool]:
    """Return (has_header, entries, bad_line_count, spaces_instead_of_tabs)."""
    lines = text.splitlines()
    first = next((ln.strip() for ln in lines if ln.strip()), "")
    has_header = first.startswith(HEADER_PREFIXES)
    entries: list[_Entry] = []
    bad = 0
    spaces = False
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#"):
            continue
        parts = raw.strip("\r\n").split("\t")
        if parts[0].startswith("#HttpOnly_"):
            parts[0] = parts[0][len("#HttpOnly_"):]
        if len(parts) < 7:
            bad += 1
            if "\t" not in line and len(line.split()) >= 7:
                spaces = True
            continue
        domain, _sub, _path, _secure, expires, name = (p.strip() for p in parts[:6])
        # parts[6] is the value: deliberately ignored.
        try:
            exp = int(float(expires)) if expires else 0
        except ValueError:
            bad += 1
            continue
        entries.append(_Entry(domain.lower(), name, exp))
    return has_header, entries, bad, spaces


def _fmt(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def check_cookies(path: str | Path, now: float | None = None) -> CookieReport:
    now = time.time() if now is None else now
    resolved, notes = resolve_cookie_path(path)
    report = CookieReport(resolved)
    report.warnings.extend(notes)
    if resolved is None:
        report.errors.append(f"Cookies file not found: {expand(path)}. {EXPORT_HINT}")
        return report

    try:
        data = resolved.read_bytes()
    except OSError as e:
        report.errors.append(f"Can't read the cookies file ({e.strerror or e}).")
        return report
    if not data.strip():
        report.errors.append(f"The cookies file is empty. {EXPORT_HINT}")
        return report
    text = data.decode("utf-8-sig", errors="replace")
    if text.lstrip()[:1] in ("[", "{"):
        report.errors.append("This is a JSON cookie export, not Netscape format. In the extension choose "
                             "the 'Netscape' (cookies.txt) format and export again.")
        return report

    has_header, entries, bad, spaces = _parse(text)
    if not entries:
        msg = "This doesn't look like a Netscape-format cookies.txt (no valid cookie lines)."
        if spaces:
            msg += " Tabs seem to have been replaced by spaces - don't open and re-save it in an editor."
        report.errors.append(f"{msg} {EXPORT_HINT}")
        return report
    if not has_header:
        report.warnings.append("The '# Netscape HTTP Cookie File' header line is missing; yt-dlp may reject "
                               "the file. Re-export it, or add that line at the top.")
    if bad:
        report.warnings.append(f"{bad} line(s) couldn't be parsed and will be ignored.")

    yt = [e for e in entries if e.domain.lstrip(".").endswith("youtube.com")]
    report.youtube_cookies = len(yt)
    if not yt:
        report.errors.append("No youtube.com cookies in the file (it was probably exported from another site). "
                             + EXPORT_HINT)
        return report

    login = [e for e in yt if e.name in LOGIN_COOKIES]
    report.login_cookies = sorted({e.name for e in login})
    if not login:
        report.errors.append("No YouTube login cookie (SID / __Secure-3PSID / LOGIN_INFO) found: the export "
                             "wasn't made while signed in. " + EXPORT_HINT)
        return report

    expired = [e for e in login if 0 < e.expires < now]
    alive = [e for e in login if e.expires == 0 or e.expires >= now]
    if not alive:
        latest = max(e.expires for e in expired)
        report.errors.append(f"All YouTube login cookies have expired (latest on {_fmt(latest)}). "
                             "Re-export cookies.txt.")
    elif expired:
        names = ", ".join(sorted({e.name for e in expired}))
        report.warnings.append(f"Some login cookies have expired ({names}); if downloads fail, re-export cookies.txt.")
    soon = [e for e in alive if 0 < e.expires < now + 86400]
    if alive and soon and len(soon) == len(alive):
        report.warnings.append(f"Login cookies expire within a day ({_fmt(min(e.expires for e in soon))}).")
    other_expired = sum(1 for e in yt if 0 < e.expires < now and e.name not in LOGIN_COOKIES)
    if other_expired:
        report.info.append(f"{other_expired} non-login youtube.com cookie(s) are expired (usually harmless).")

    try:
        age_days = (now - resolved.stat().st_mtime) / 86400
        if age_days > STALE_FILE_DAYS:
            report.warnings.append(f"The file is {int(age_days)} days old; YouTube rotates sessions, so "
                                   "re-export it if members-only videos fail.")
    except OSError:
        pass

    report.info.append(f"Found {len(yt)} youtube.com cookies; login cookies: {', '.join(report.login_cookies)}.")
    return report
