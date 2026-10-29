"""Offline tests for track selection, retry and batch handling (yt-dlp calls are stubbed)."""
from pathlib import Path

from app.core import captions, pipeline
from app.core.captions import Track, VideoInfo
from app.core.paths import safe_filename
from app.core.pipeline import JobOptions


def video(manual=(), auto=(), language=None):
    m = {c: Track(c, c, "manual") for c in manual}
    a = {c: Track(c, c, "auto") for c in auto}
    return VideoInfo("abcdefghijk", "T", "u", 60, language, captions.detect_native({"language": language}, m, a),
                     m, a)


def test_parse_lang_spec():
    assert captions.parse_lang_spec("native, hi,EN, hi") == ["native", "hi", "EN"]
    assert captions.parse_lang_spec("") == ["native"]


def test_native_prefers_orig_auto_track():
    v = video(auto=["hi-orig", "hi", "en", "fr"])
    sel, missing = captions.select_tracks(v, ["native"])
    assert v.native == "hi" and sel[0].track.code == "hi-orig" and sel[0].label == "hi" and not missing


def test_uploaded_subtitles_beat_auto_captions():
    v = video(manual=["hi"], auto=["hi-orig", "en"])
    sel, _ = captions.select_tracks(v, ["native", "en"])
    assert [(s.track.code, s.track.source) for s in sel] == [("hi", "manual"), ("en", "auto")]


def test_regional_variant_matches_and_duplicates_collapse():
    v = video(manual=["en-GB"], auto=["en-orig"])
    sel, _ = captions.select_tracks(v, ["en", "native", "en"])
    assert [s.track.code for s in sel] == ["en-GB"]


def test_missing_language_reported():
    v = video(auto=["hi-orig"])
    sel, missing = captions.select_tracks(v, ["hi", "ta"])
    assert [s.track.code for s in sel] == ["hi-orig"] and missing == ["ta"]


def test_no_captions_at_all():
    v = video()
    sel, missing = captions.select_tracks(v, ["native"])
    assert not sel and missing == ["native"]


def test_safe_filename():
    assert safe_filename('a/b:c*?"<>|') == "a_b_c______"
    assert safe_filename("CON") == "_CON"
    assert safe_filename("नमस्ते  दुनिया. ") == "नमस्ते दुनिया"


def test_read_url_list():
    assert pipeline.read_url_list("a\n\n# c\nb\na\n") == ["a", "b"]


def test_retry_on_429(monkeypatch):
    calls = []
    monkeypatch.setattr(pipeline, "_sleep", lambda s, c: calls.append(s) or True)

    def flaky():
        if len(calls) < 2:
            raise Exception("HTTP Error 429: Too Many Requests")
        return "ok"

    opts = JobOptions(retries=3, retry_delay=10)
    assert pipeline.with_retry(flaky, opts, lambda *a: None, "testing") == "ok"
    assert calls == [10, 20]


def test_retry_gives_up(monkeypatch):
    monkeypatch.setattr(pipeline, "_sleep", lambda s, c: True)

    def always():
        raise Exception("HTTP Error 429: Too Many Requests")

    try:
        pipeline.with_retry(always, JobOptions(retries=2), lambda *a: None, "testing")
    except Exception as e:
        assert "429" in str(e)
    else:
        raise AssertionError("should have raised")


def test_batch_skips_and_reports_failures(monkeypatch, tmp_path):
    def fake_process(url, opts, log, ask=None, progress=None, cancel=None):
        r = pipeline.VideoResult(url, title=url)
        if "bad" in url:
            r.error = pipeline.classify("Join this channel to get access to members-only content")
        else:
            r.files = [tmp_path / f"{url}.srt"]
        return r

    monkeypatch.setattr(pipeline, "process_video", fake_process)
    logs = []
    urls = ["ok1", "bad1", "ok2", "bad2", "ok3"]
    results = pipeline.run_job(urls, JobOptions(batch_delay=0), lambda lvl, m: logs.append((lvl, m)))
    assert [r.ok for r in results] == [True, False, True, False, True]
    assert any("3 succeeded, 2 failed" in m for _, m in logs)


def test_members_only_error_is_friendly(monkeypatch):
    def boom(*a, **k):
        raise Exception("ERROR: [youtube] abcdefghijk: Join this channel to get access to members-only content")

    monkeypatch.setattr(captions, "fetch_info", boom)
    logs = []
    r = pipeline.process_video("u", JobOptions(), lambda lvl, m: logs.append((lvl, m)))
    assert r.error.code == "MEMBERS_ONLY"
    assert any(lvl == "error" and "Re-export cookies.txt" in m for lvl, m in logs)


def test_delete_cookies_after_run(monkeypatch, tmp_path):
    cookie = tmp_path / "cookies.txt"
    cookie.write_text("x")
    monkeypatch.setattr(pipeline, "process_video", lambda *a, **k: pipeline.VideoResult("u", files=[Path("f")]))
    opts = JobOptions(cookies=captions.CookieSource(path=cookie), delete_cookies_after=True)
    pipeline.run_job(["u"], opts, lambda *a: None)
    assert not cookie.exists()
