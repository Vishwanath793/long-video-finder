"""VTT/SRT parsing, YouTube rolling-caption cleanup, and SRT/TXT writers."""
from __future__ import annotations

import html
import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

_TIME = r"(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}"
_TIMING_RE = re.compile(rf"^\s*({_TIME})\s*-->\s*({_TIME})")
_TAG_RE = re.compile(r"<[^>]*>")
_ASS_RE = re.compile(r"\{\\[^}]*\}")
_INLINE_TIME_RE = re.compile(r"<\d{1,2}:\d{2}[:.]\d{2}")
_SENTENCE_END = (".", "?", "!", "।", "॥", "…")  # incl. Devanagari danda । ॥


@dataclass
class Cue:
    start: float
    end: float
    lines: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(self.lines)


def parse_timestamp(value: str) -> float:
    value = value.strip().replace(",", ".")
    main, _, frac = value.partition(".")
    parts = [int(p) for p in main.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts
    return h * 3600 + m * 60 + s + int(frac.ljust(3, "0")[:3]) / 1000


def clean_line(line: str) -> str:
    """Strip VTT/HTML/ASS tags and entities; collapse whitespace."""
    line = _ASS_RE.sub("", _TAG_RE.sub("", line))
    line = html.unescape(line).replace(" ", " ").replace("​", "")
    return re.sub(r"\s+", " ", line).strip()


def parse_cues(text: str) -> list[Cue]:
    """Parse WebVTT or SRT. Handles YouTube's whitespace-only lines inside cues and sloppy SRT numbering."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[Cue] = []
    cur: Cue | None = None
    raw: list[str] = []  # raw text lines of the current cue
    closed = True  # an empty line ends a cue; anything after it until the next timing line is ignored
    for line in text.split("\n"):
        m = _TIMING_RE.match(line)
        if m:
            if cur is not None and not closed and raw and raw[-1].strip().isdigit():
                raw.pop()  # SRT cue number that followed a whitespace-only "blank" line
            _finish(cur, raw, cues)
            cur, raw, closed = Cue(parse_timestamp(m.group(1)), parse_timestamp(m.group(2))), [], False
            continue
        if line == "":
            closed = True
            continue
        if cur is not None and not closed:
            raw.append(line)
    _finish(cur, raw, cues)
    return cues


def _finish(cue: Cue | None, raw: list[str], out: list[Cue]) -> None:
    if cue is None:
        return
    cue.lines = [c for c in (clean_line(r) for r in raw) if c]
    if cue.lines:
        out.append(cue)


def load_cues(path: str | Path) -> tuple[list[Cue], str]:
    raw = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    return parse_cues(raw), raw


def looks_rolling(raw_text: str, cues: list[Cue]) -> bool:
    """Detect YouTube auto-caption style where each cue repeats the previous cue's line."""
    if "<c>" in raw_text or _INLINE_TIME_RE.search(raw_text):
        return True
    if len(cues) < 4:
        return False
    repeats = sum(1 for a, b in zip(cues, cues[1:]) if a.lines and b.lines and b.lines[0] == a.lines[-1])
    return repeats / (len(cues) - 1) > 0.3


def dedupe_rolling(cues: list[Cue], window: int = 2) -> list[Cue]:
    """Keep only new text from each cue; merge 'growing' lines; drop the 10 ms duplicate cues."""
    out: list[Cue] = []
    recent: deque[str] = deque(maxlen=window)
    for cue in cues:
        new: list[str] = []
        for line in cue.lines:
            if line in recent:
                continue
            last = recent[-1] if recent else None
            if last and line.startswith(last) and out and out[-1].lines and out[-1].lines[-1] == last:
                out[-1].lines[-1] = line  # the line grew (word-by-word captions)
                out[-1].end = max(out[-1].end, cue.end)
                recent[-1] = line
                continue
            new.append(line)
            recent.append(line)
        if new:
            if out and out[-1].end > cue.start:
                out[-1].end = cue.start
            out.append(Cue(cue.start, max(cue.end, cue.start), new))
        elif out:
            out[-1].end = max(out[-1].end, cue.end)
    return out


def format_srt_time(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def cues_to_srt(cues: list[Cue]) -> str:
    blocks = [f"{i}\n{format_srt_time(c.start)} --> {format_srt_time(c.end)}\n" + "\n".join(c.lines)
              for i, c in enumerate(cues, 1)]
    return "\n\n".join(blocks) + "\n" if blocks else ""


def cues_to_paragraphs(cues: list[Cue], gap: float = 2.0, max_chars: int = 500) -> list[str]:
    """Join caption lines into readable paragraphs; break on pauses or at sentence ends once long."""
    paragraphs: list[str] = []
    current: list[str] = []
    length = 0
    prev_end: float | None = None
    last_line = None
    for cue in cues:
        if current and prev_end is not None and cue.start - prev_end > gap:
            paragraphs.append(" ".join(current))
            current, length = [], 0
        for line in cue.lines:
            if line == last_line:
                continue  # consecutive duplicates
            last_line = line
            current.append(line)
            length += len(line) + 1
            if length >= max_chars * 1.6 or (length >= max_chars and line.endswith(_SENTENCE_END)):
                paragraphs.append(" ".join(current))
                current, length = [], 0
        prev_end = cue.end
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


def cues_to_text(cues: list[Cue]) -> str:
    paras = cues_to_paragraphs(cues)
    return "\n\n".join(paras) + "\n" if paras else ""


def write_text(path: str | Path, text: str, bom: bool = False) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="\r\n" so old Notepad versions show line breaks too.
    with open(path, "w", encoding="utf-8-sig" if bom else "utf-8", newline="\r\n") as f:
        f.write(text)
    return path


def clean_cues(cues: list[Cue], raw_text: str = "", rolling: bool | None = None) -> list[Cue]:
    if rolling is None:
        rolling = looks_rolling(raw_text, cues)
    return dedupe_rolling(cues) if rolling else cues


def convert_file(src: str | Path, srt_path: str | Path | None = None, txt_path: str | Path | None = None,
                 rolling: bool | None = None, bom: bool = True) -> list[Path]:
    """Convert a downloaded VTT/SRT to a clean .srt and/or plain .txt (BOM only applied to .txt)."""
    cues, raw = load_cues(src)
    cues = clean_cues(cues, raw, rolling)
    written: list[Path] = []
    if srt_path:
        written.append(write_text(srt_path, cues_to_srt(cues)))
    if txt_path:
        written.append(write_text(txt_path, cues_to_text(cues), bom=bom))
    return written
