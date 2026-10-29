from pathlib import Path

from app.core import convert
from app.core.convert import Cue

DATA = Path(__file__).parent / "data"


def test_parse_timestamps():
    assert convert.parse_timestamp("00:00:01.120") == 1.12
    assert convert.parse_timestamp("01:02.5") == 62.5
    assert convert.parse_timestamp("1:00:00,001") == 3600.001
    assert convert.format_srt_time(3723.456) == "01:02:03,456"


def test_auto_rolling_is_detected_and_deduped():
    cues, raw = convert.load_cues(DATA / "auto_rolling_en.vtt")
    assert convert.looks_rolling(raw, cues)
    clean = convert.dedupe_rolling(cues)
    assert [c.text for c in clean] == [
        "hello everyone and welcome",
        "to the channel",
        "today we talk about python",
        "after the break",
    ]
    # no overlapping cues after cleanup
    assert all(a.end <= b.start for a, b in zip(clean, clean[1:]))


def test_auto_rolling_text_has_no_timestamps_or_repeats(tmp_path):
    srt, txt = tmp_path / "a.srt", tmp_path / "a.txt"
    convert.convert_file(DATA / "auto_rolling_en.vtt", srt, txt, rolling=True)
    text = txt.read_text(encoding="utf-8-sig")
    assert "-->" not in text and "<c>" not in text and "00:00" not in text
    assert text.count("hello everyone and welcome") == 1
    assert text.count("to the channel") == 1
    # the 4.5 s pause starts a new paragraph
    assert text.replace("\r\n", "\n") == ("hello everyone and welcome to the channel today we talk about python\n\n"
                                          "after the break\n")
    srt_text = srt.read_text(encoding="utf-8")
    assert srt_text.startswith("1\n00:00:00,160 --> ") or srt_text.startswith("1\r\n00:00:00,160 --> ")
    assert srt_text.count("to the channel") == 1


def test_devanagari_manual_vtt(tmp_path):
    cues, raw = convert.load_cues(DATA / "manual_hi.vtt")
    assert not convert.looks_rolling(raw, cues)
    assert [c.text for c in cues] == [
        "नमस्ते दोस्तों, आज हम बात करेंगे & सीखेंगे।",
        "यह वीडियो सदस्यों के लिए है।",
        "धन्यवाद!",
    ]
    txt = tmp_path / "hi.txt"
    convert.convert_file(DATA / "manual_hi.vtt", txt_path=txt, bom=True)
    data = txt.read_bytes()
    assert data.startswith(b"\xef\xbb\xbf")  # BOM so old Notepad detects UTF-8
    assert "नमस्ते दोस्तों" in data.decode("utf-8-sig")


def test_no_bom_option(tmp_path):
    txt = tmp_path / "hi.txt"
    convert.convert_file(DATA / "manual_hi.vtt", txt_path=txt, bom=False)
    assert not txt.read_bytes().startswith(b"\xef\xbb\xbf")


def test_srt_parsing_strips_tags_numbers_and_whitespace_separators():
    cues, _ = convert.load_cues(DATA / "sample.srt")
    assert [c.lines for c in cues] == [["First line"], ["Second line", "wraps here"], ["Third"]]


def test_growing_lines_are_merged():
    cues = [Cue(0, 1, ["hello"]), Cue(1, 2, ["hello world"]), Cue(2, 3, ["hello world again"]), Cue(3, 4, ["next"])]
    out = convert.dedupe_rolling(cues)
    assert [c.text for c in out] == ["hello world again", "next"]


def test_paragraph_breaks_on_long_text():
    cues = [Cue(i, i + 1, [f"sentence number {i}."]) for i in range(100)]
    paras = convert.cues_to_paragraphs(cues, max_chars=200)
    assert len(paras) > 3
    assert all(len(p) < 400 for p in paras)


def test_consecutive_duplicate_lines_removed_from_text():
    cues = [Cue(0, 1, ["same"]), Cue(1, 2, ["same"]), Cue(2, 3, ["other"])]
    assert convert.cues_to_text(cues) == "same other\n"
