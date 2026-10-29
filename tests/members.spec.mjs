// Members-only tab. The Python helper is mocked in the browser tests: no cookies are read, nothing is
// downloaded and nothing is added to the library.
import { test, expect } from '@playwright/test';
import { toEntries } from '../members.mjs';
import { hasTranscript } from '../subtitles.mjs';
import { netscape } from '../ytbrowser.mjs';

async function mockHelper(page) {
  const sent = { run: [], answer: [] };
  let polls = 0;
  const job = { id: 41, action: 'download', running: true, progress: 0.5, question: null, result: null, error: null, added: 0 };
  await page.route('**/api/members/status', r => r.fulfill({ json: { ready: true, ytdlp: '2026.08.19', ffmpeg: true, whisper: true,
    folder: 'C:\\x\\members\\', defaultCookies: 'C:\\Users\\me\\Downloads\\cookies.txt' } }));
  await page.route('**/api/members/settings', r => r.fulfill({ json: { settings: { cookiesMode: 'file', cookiesPath: '', language: 'native',
    customLanguage: '', whisperMode: 'ask', whisperModel: 'medium', whisperTask: 'transcribe', keepAudio: false, deleteCookies: false } } }));
  await page.route('**/api/members/run', r => {
    sent.run.push(r.request().postDataJSON());
    r.fulfill({ json: { job: { ...job, log: [{ level: 'info', msg: '[1/2] https://www.youtube.com/watch?v=AAAAAAAAAAA' }], logCount: 1 } } });
  });
  await page.route('**/api/members/answer', r => { sent.answer.push(r.request().postDataJSON()); r.fulfill({ json: { job: null } }); });
  await page.route('**/api/members/job*', r => {
    if (!sent.run.length) return r.fulfill({ json: { job: null } });
    polls++;
    if (polls === 1) {
      return r.fulfill({ json: { job: { ...job, question: "No captions found for 'Clip'.\n\nDownload the audio and transcribe?", log: [], logCount: 1 } } });
    }
    if (!sent.answer.length) return r.fulfill({ json: { job: { ...job, log: [], logCount: 1 } } });
    const membersOnly = { code: 'MEMBERS_ONLY', message: "This is a members-only video and YouTube didn't see a member login.", fix: 'Re-export cookies.txt' };
    r.fulfill({ json: { job: { ...job, running: false, progress: 1, added: 1, logCount: 3,
      log: [{ level: 'success', msg: 'Saved 2026-10-18_Some-Channel_AAAAAAAAAAA_hi.srt' },
            { level: 'error', msg: `${membersOnly.message} Fix: ${membersOnly.fix}` }],
      result: { videos: [
        { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', ok: true, id: 'AAAAAAAAAAA', title: 'Member stream', channel: 'Some Channel',
          iso: '2026-10-18', missing: [], tracks: [{ label: 'hi', auto: true, whisper: false, file: '2026-10-18_Some-Channel_AAAAAAAAAAA_hi', lines: 120 }] },
        { url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', ok: false, id: 'BBBBBBBBBBB', title: '', missing: [], tracks: [], error: membersOnly },
      ] } } } });
  });
  return sent;
}

async function openMembers(page) {
  await page.goto('/');
  await page.locator('#tabs button[data-tab="members"]').click();
  await expect(page.locator('#tab-members')).toBeVisible();
}

test.describe('Members-only tab', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  });
  test.afterEach(() => expect(errors, 'no errors in the page').toEqual([]));

  test('download flow: settings sent, Whisper question answered, results and friendly errors shown', async ({ page }) => {
    const sent = await mockHelper(page);
    await openMembers(page);
    await expect(page.locator('#mbStatus')).toContainText('Helper ready');
    await expect(page.locator('#mbCookiesPath')).toHaveValue('C:\\Users\\me\\Downloads\\cookies.txt');
    await expect(page.locator('#mbCustomWrap')).toBeHidden();
    await page.selectOption('#mbLanguage', 'custom');
    await expect(page.locator('#mbCustomWrap')).toBeVisible();
    await page.fill('#mbCustom', 'hi,en');
    await page.fill('#mbUrls', 'https://www.youtube.com/watch?v=AAAAAAAAAAA\nhttps://www.youtube.com/watch?v=BBBBBBBBBBB');
    await page.click('#mbDownload');
    await expect(page.locator('#mbStop')).toBeVisible();
    await expect(page.locator('#mbDownload')).toBeDisabled();
  
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modalText')).toContainText('No captions found');
    await page.click('#modalYes');
    await expect(page.locator('#mbState')).toContainText('1 transcript(s) added to the Library');
    await expect(page.locator('#mbStop')).toBeHidden();
    await expect(page.locator('#mbDownload')).toBeEnabled();
    await expect(page.locator('#mbResults')).toContainText('Member stream');
    await expect(page.locator('#mbResults a[href="/files/2026-10-18_Some-Channel_AAAAAAAAAAA_hi.srt"]')).toHaveCount(1);
    await expect(page.locator('#mbResults .err')).toContainText('members-only');
    await expect(page.locator('#mbLog .err')).toHaveCount(1);
  
    expect(sent.answer).toEqual([{ yes: true }]);
    expect(sent.run[0]).toMatchObject({ action: 'download', cookiesMode: 'file', language: 'custom', customLanguage: 'hi,en',
      cookiesPath: 'C:\\Users\\me\\Downloads\\cookies.txt', whisperMode: 'ask' });
  });
  
  test('Advanced: cookie path only for the cookies.txt source; account bar only for the app sign-in', async ({ page }) => {
    await mockHelper(page);
    await page.route('**/api/members/account*', r => r.fulfill({ json: { browser: 'chrome.exe', signedIn: false, signingIn: false } }));
    await openMembers(page);
    await page.locator('summary', { hasText: 'Advanced' }).click();
    await expect(page.locator('#mbPathWrap')).toBeVisible();
    await expect(page.locator('#mbAccountCard')).toBeHidden();
    await page.selectOption('#mbCookiesMode', 'firefox');
    await expect(page.locator('#mbPathWrap')).toBeHidden();
    await page.selectOption('#mbCookiesMode', 'app');
    await expect(page.locator('#mbAccountCard')).toBeVisible();
    await expect(page.locator('#mbDeleteWrap')).toBeHidden();
  });

  test('one-time sign-in: not signed in -> window open -> signed in', async ({ page }) => {
    await mockHelper(page);
    // Settings say "app" (the default); the account goes through the three states.
    await page.route('**/api/members/settings', r => r.fulfill({ json: { settings: { cookiesMode: 'app', cookiesPath: '', language: 'native',
      customLanguage: '', whisperMode: 'ask', whisperModel: 'medium', whisperTask: 'transcribe', keepAudio: false, deleteCookies: false } } }));
    let state = 'out', signIns = 0, accountCalls = 0;
    await page.route('**/api/members/sign-in', r => { signIns++; state = 'window'; r.fulfill({ json: { signingIn: true } }); });
    await page.route('**/api/members/account*', r => {
      accountCalls++;
      if (state === 'window' && accountCalls > 3) state = 'in'; // the user closed the window after signing in
      r.fulfill({ json: { browser: 'chrome.exe', signingIn: state === 'window', inUse: state === 'window', signedIn: state === 'in' } });
    });
    await openMembers(page);
    await expect(page.locator('#mbAccount')).toContainText('Not signed in');
    await expect(page.locator('#mbAccountHelp')).toBeVisible();
    await page.click('#mbSignIn');
    await expect(page.locator('#mbAccount')).toContainText('Sign-in window is open');
    await expect(page.locator('#mbSignIn')).toBeHidden();
    await expect(page.locator('#mbAccount')).toContainText('Signed in to YouTube', { timeout: 15_000 });
    await expect(page.locator('#mbSignOut')).toBeVisible();
    expect(signIns).toBe(1);
  });
});

test('other websites cannot drive the helper', async ({ request }) => {
  const res = await request.post('/api/members/run', { headers: { Origin: 'https://evil.example' }, data: { action: 'check' } });
  expect(res.status()).toBe(403);
});

test('helper results become library entries, one per language', () => {
  const entries = toEntries([
    { url: 'u', url_canonical: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', id: 'AAAAAAAAAAA', title: 'Stream', channel: 'Some Channel',
      iso: '2026-10-18', duration: 3725, tracks: [
        { label: 'hi', auto: true, whisper: false, file: '2026-10-18_Some-Channel_AAAAAAAAAAA_hi', lines: 10 },
        { label: 'en', auto: false, whisper: false, file: '2026-10-18_Some-Channel_AAAAAAAAAAA_en', lines: 9 }] },
    { url: 'x', id: '', title: '', tracks: [], error: { message: 'nope' } },
  ], 'NOW');
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ iso: '2026-10-18', date: '18 October 2026', channel: 'Some Channel', videoId: 'AAAAAAAAAAA',
    title: 'Stream [hi]', duration: '1:02:05', language: 'hi', auto: true, lines: 10, source: 'members',
    file: '2026-10-18_Some-Channel_AAAAAAAAAAA_hi', downloadedAt: 'NOW',
    downsub: 'https://downsub.com/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DAAAAAAAAAAA' });
});

test('browser cookies are written in Netscape format for yt-dlp', () => {
  const text = netscape([
    { domain: '.youtube.com', path: '/', secure: true, expires: 1893456000.5, name: 'SID', value: 'v1' },
    { domain: 'www.youtube.com', path: '/', secure: false, expires: -1, name: 'YSC', value: 'v2' },
  ]);
  const lines = text.trim().split('\n');
  expect(lines[0]).toBe('# Netscape HTTP Cookie File');
  expect(lines.at(-2)).toBe('.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tv1');
  expect(lines.at(-1)).toBe('www.youtube.com\tFALSE\t/\tFALSE\t0\tYSC\tv2'); // host-only, session cookie
});

test("members entries don't count as a channel's daily stream", () => {
  expect(hasTranscript([{ iso: '2026-10-18', channel: 'Zee Business', source: 'members' }], '2026-10-18', 'Zee Business')).toBe(false);
  expect(hasTranscript([{ iso: '2026-10-18', channel: 'Zee Business' }], '2026-10-18', 'Zee Business')).toBe(true);
});
