import time

from app.core.cookies import check_cookies, resolve_cookie_path

NOW = time.time()
FUTURE = int(NOW + 180 * 86400)
PAST = int(NOW - 10 * 86400)
HEADER = "# Netscape HTTP Cookie File\n# This is a generated file! Do not edit.\n\n"


def line(name, expires=FUTURE, domain=".youtube.com", value="SECRETVALUE"):
    return f"{domain}\tTRUE\t/\tTRUE\t{expires}\t{name}\t{value}\n"


def write(tmp_path, body, name="cookies.txt"):
    p = tmp_path / name
    p.write_text(body, encoding="utf-8")
    return p


def test_valid_file(tmp_path):
    p = write(tmp_path, HEADER + line("PREF") + line("SID") + "#HttpOnly_" + line("__Secure-3PSID")
              + line("LOGIN_INFO"))
    r = check_cookies(p, now=NOW)
    assert r.ok, r.errors
    assert r.login_cookies == ["LOGIN_INFO", "SID", "__Secure-3PSID"]
    assert r.youtube_cookies == 4
    assert not r.warnings


def test_values_never_appear_in_report(tmp_path):
    p = write(tmp_path, HEADER + line("SID"))
    r = check_cookies(p, now=NOW)
    assert all("SECRETVALUE" not in text for _, text in r.lines())


def test_missing_file(tmp_path):
    r = check_cookies(tmp_path / "cookies.txt", now=NOW)
    assert not r.ok and "not found" in r.errors[0]


def test_txt_txt_naming_mistake(tmp_path):
    write(tmp_path, HEADER + line("SID"), name="cookies.txt.txt")
    path, notes = resolve_cookie_path(tmp_path / "cookies.txt")
    assert path.name == "cookies.txt.txt" and notes
    r = check_cookies(tmp_path / "cookies.txt", now=NOW)
    assert r.ok and any(".txt.txt" in w for w in r.warnings)


def test_folder_given_instead_of_file(tmp_path):
    write(tmp_path, HEADER + line("SID"))
    assert resolve_cookie_path(tmp_path)[0].name == "cookies.txt"


def test_wrong_format(tmp_path):
    p = write(tmp_path, "SID=abc; HSID=def; PREF=xyz\n")
    r = check_cookies(p, now=NOW)
    assert not r.ok and "Netscape" in r.errors[0]


def test_json_export(tmp_path):
    p = write(tmp_path, '[{"domain": ".youtube.com", "name": "SID", "value": "x"}]')
    r = check_cookies(p, now=NOW)
    assert not r.ok and "JSON" in r.errors[0]


def test_missing_header_is_a_warning(tmp_path):
    p = write(tmp_path, line("SID"))
    r = check_cookies(p, now=NOW)
    assert r.ok and any("header" in w for w in r.warnings)


def test_no_youtube_cookies(tmp_path):
    p = write(tmp_path, HEADER + line("SID", domain=".google.com"))
    r = check_cookies(p, now=NOW)
    assert not r.ok and "youtube.com" in r.errors[0]


def test_missing_login_cookie(tmp_path):
    p = write(tmp_path, HEADER + line("PREF") + line("VISITOR_INFO1_LIVE") + line("YSC", expires=0))
    r = check_cookies(p, now=NOW)
    assert not r.ok and "login cookie" in r.errors[0]


def test_all_login_cookies_expired(tmp_path):
    p = write(tmp_path, HEADER + line("SID", PAST) + line("LOGIN_INFO", PAST) + line("PREF"))
    r = check_cookies(p, now=NOW)
    assert not r.ok and "expired" in r.errors[0]


def test_some_login_cookies_expired(tmp_path):
    p = write(tmp_path, HEADER + line("SID", PAST) + line("__Secure-3PSID"))
    r = check_cookies(p, now=NOW)
    assert r.ok and any("expired" in w for w in r.warnings)


def test_session_cookies_count_as_alive(tmp_path):
    p = write(tmp_path, HEADER + line("SID", expires=0))
    assert check_cookies(p, now=NOW).ok


def test_spaces_instead_of_tabs(tmp_path):
    p = write(tmp_path, HEADER + line("SID").replace("\t", " "))
    r = check_cookies(p, now=NOW)
    assert not r.ok and "Tabs" in r.errors[0]


def test_empty_file(tmp_path):
    r = check_cookies(write(tmp_path, ""), now=NOW)
    assert not r.ok and "empty" in r.errors[0]
