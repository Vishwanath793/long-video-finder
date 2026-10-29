// End-to-end tests of every tab in a real browser.
// Safe to run any time: AI analysis requests, settings saves, watchlist saves and the Windows scheduled task
// are intercepted (recorded, never sent), and every AI cost question is answered "Not now".
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Intercepts everything that spends money or changes the PC; returns what the page tried to send.
async function guard(page) {
  const sent = { analyze: [], settings: [], watchlist: [], schedule: [] };
  await page.route('**/api/ai/analyze', r => { sent.analyze.push(r.request().postDataJSON()); r.fulfill({ json: { started: 0 } }); });
  await page.route('**/api/watchlist', async r => {
    if (r.request().method() !== 'PUT') return r.continue();
    sent.watchlist.push(r.request().postDataJSON());
    r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/settings', async r => {
    if (r.request().method() !== 'PUT') return r.continue();
    sent.settings.push(r.request().postDataJSON());
    const real = await (await r.fetch({ method: 'GET', postData: undefined })).json(); // answer with the unchanged settings
    r.fulfill({ json: real });
  });
  await page.route('**/api/schedule', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    const body = r.request().postDataJSON();
    sent.schedule.push(body);
    r.fulfill({ json: body.action === 'run-now' ? { ok: true } : { task: { installed: body.action === 'install' } } });
  });
  return sent;
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
});
test.afterEach(() => expect(errors, 'no errors in the page').toEqual([]));

async function open(page, tab) {
  const sent = await guard(page);
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.locator(`#tabs button[data-tab="${tab}"]`).click();
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
  return sent;
}
// isVisible() doesn't wait; this does. True if the element appears within ms.
const shows = (loc, ms) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const download = async (page, click) => {
  const [d] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: d.suggestedFilename(), body: await readFile(await d.path()) };
};

// ---------------------------------------------------------------- general
test('all 10 tabs open and switch', async ({ page }) => {
  await open(page, 'find');
  for (const tab of ['find', 'members', 'library', 'search', 'mentions', 'calls', 'report', 'summaries', 'daily', 'settings']) {
    await page.locator(`#tabs button[data-tab="${tab}"]`).click();
    await expect(page.locator(`#tab-${tab}`)).toBeVisible();
    await expect(page.locator(`#tabs button[data-tab="${tab}"]`)).toHaveClass(/on/);
  }
  await expect(page.locator('#tabs button')).toHaveCount(10);
});

test('AI is the default source on Calls, Analyst report and Summaries', async ({ page }) => {
  await open(page, 'calls');
  for (const id of ['#cSource', '#rSource', '#ySource']) await expect(page.locator(id)).toHaveValue('ai');
});

// ---------------------------------------------------------------- find & download
test.describe('Find & download', () => {
  test('find links for 16 Oct, copy, CSV and ZIP downloads', async ({ page }) => {
    await open(page, 'find');
    await page.fill('#from', '2026-10-16');
    await page.fill('#to', '2026-10-16');
    await page.click('#go');
    await expect(page.locator('#status')).toContainText('Done: 2 of 2 found', { timeout: 90_000 });
    const results = page.locator('#results');
    await expect(results).toContainText('Zee Business');
    await expect(results).toContainText('CNBC Awaaz');
    await expect(results).toContainText('https://downsub.com/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D');

    // Copy one DownSub link.
    const copyBtn = results.locator('button[data-copy]').first();
    await copyBtn.click();
    await expect(copyBtn).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^https:\/\/downsub\.com\/\?url=/);

    // Copy all DownSub links: one per line.
    await page.click('#copyDs');
    expect((await page.evaluate(() => navigator.clipboard.readText())).split('\n')).toHaveLength(2);

    const csv = await download(page, () => page.click('#csv'));
    expect(csv.name).toBe('videos_2026-10-16_2026-10-16.csv');
    expect(csv.body.toString()).toContain('"Date","Channel","Video Title"');

    const zip = await download(page, () => page.click('#zipTxt'));
    expect(zip.name).toMatch(/^subtitles_txt_2026-10-16_to_2026-10-16\.zip$/);
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
  });

  test('find + download: transcripts already in the library are not downloaded again', async ({ page }) => {
    await open(page, 'find');
    await page.fill('#from', '2026-10-16');
    await page.fill('#to', '2026-10-16');
    await page.click('#collect');
    await expect(page.locator('#status')).toContainText('2 already had', { timeout: 90_000 });
    await expect(page.locator('.badge.have')).toHaveCount(2);
  });

  test('Today button sets both dates to today', async ({ page }) => {
    await open(page, 'find');
    await page.fill('#from', '2026-01-01');
    await page.click('#today');
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'));
    await expect(page.locator('#from')).toHaveValue(today);
    await expect(page.locator('#to')).toHaveValue(today);
  });

  test('add videos by URL: sends the links, shows saved and failed ones', async ({ page }) => {
    await open(page, 'find');
    let sent = null;
    await page.route('**/api/urls', r => { // intercepted: nothing is added to the library
      sent = r.request().postDataJSON();
      r.fulfill({ json: { results: [
        { url: sent.urls[0], status: 'saved', entry: { iso: '2026-10-16', date: '16 October 2026', channel: 'CNBC Awaaz', videoId: 'ukqR75dSHas',
          title: 'Big Market Voice', duration: '0:08:10', url: 'https://www.youtube.com/watch?v=ukqR75dSHas',
          downsub: 'https://downsub.com/?url=x', lines: 177, auto: true, language: 'hi', file: 'test', source: 'url', dateSource: 'YouTube publish date' } },
        { url: sent.urls[1], status: 'error', error: 'Not a YouTube video link' },
      ] } });
    });
    await page.locator('#urls').click();
    await page.keyboard.type('https://youtu.be/ukqR75dSHas');
    await page.keyboard.press('Enter');
    await page.keyboard.type('https://example.com/x');
    await page.selectOption('#urlChannel', 'CNBC Awaaz');
    await page.fill('#urlDate', '2026-10-16');
    await page.click('#urlGo');
    await expect(page.locator('#status')).toContainText('Done: 1 of 2 saved');
    expect(sent).toMatchObject({ urls: ['https://youtu.be/ukqR75dSHas', 'https://example.com/x'], iso: '2026-10-16', channel: 'CNBC Awaaz' });
    await expect(page.locator('#results')).toContainText('Big Market Voice');
    await expect(page.locator('#results')).toContainText('YouTube publish date');
    await expect(page.locator('#results')).toContainText('Not a YouTube video link');
    await expect(page.locator('#urls')).not.toHaveValue(''); // failed links stay in the box to retry
  });

  test('NSE holidays are skipped', async ({ page }) => {
    await open(page, 'find');
    await page.fill('#from', '2026-10-02'); // Gandhi Jayanti, then a weekend
    await page.fill('#to', '2026-10-04');
    await page.click('#go');
    await expect(page.locator('#status')).toContainText('No trading days');
  });

  test('channel editor: add, remove, reset', async ({ page }) => {
    await open(page, 'find');
    await page.click('summary:has-text("Channels and search queries")');
    const rows = page.locator('#channels .ch');
    await expect(rows).toHaveCount(2);
    await page.click('#addCh');
    await expect(rows).toHaveCount(3);
    await rows.nth(2).locator('button').click();
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator('button').click();
    await expect(rows).toHaveCount(1);
    await page.click('#resetCh');
    await expect(rows).toHaveCount(2);
  });
});

// ---------------------------------------------------------------- library
test('Library: list, filter, transcript files and ZIP', async ({ page, request }) => {
  await open(page, 'library');
  await expect(page.locator('#libBody tr').first()).toBeVisible();
  const all = await page.locator('#libBody tr').count();
  expect(all).toBeGreaterThan(20);
  await page.selectOption('#libChannel', 'CNBC Awaaz');
  const cnbc = await page.locator('#libBody tr').count();
  expect(cnbc).toBeLessThan(all);
  await expect(page.locator('#libBody')).not.toContainText('Zee Business');

  const srt = await page.locator('#libBody a:has-text("SRT")').first().getAttribute('href');
  const res = await request.get(srt);
  expect(res.status()).toBe(200);
  expect(await res.text()).toMatch(/^\uFEFF?1\r?\n\d\d:\d\d:\d\d,\d{3} --> /);

  const zip = await download(page, () => page.click('#libZipSrt'));
  expect(zip.name).toMatch(/^subtitles_srt_.*\.zip$/);
  expect(zip.body.subarray(0, 2).toString()).toBe('PK');
});

// ---------------------------------------------------------------- search & mentions
test.describe('Search and mentions', () => {
  test('search a stock (all spellings) and a Hindi word', async ({ page }) => {
    await open(page, 'search');
    await page.fill('#sFrom', '2026-10-16');
    await page.fill('#sTo', '2026-10-16');
    await page.fill('#q', 'Reliance');
    await page.press('#q', 'Enter');
    await expect(page.locator('#sStatus')).toContainText('matched Reliance Industries');
    const link = await page.locator('.hit a').first().getAttribute('href');
    expect(link).toMatch(/youtube\.com\/watch\?v=.+&t=\d+s$/);

    await page.fill('#q', 'आईपीओ');
    await page.click('#sGo');
    await expect(page.locator('#sStatus')).toContainText(/\d+ mentions? in \d+ transcripts/);
    await expect(page.locator('.hit mark').first()).toBeVisible();
  });

  // fill() inserts text without key presses, which hid a bug that cancelled every key typed here.
  test('typing with the real keyboard works in every text box', async ({ page }) => {
    await open(page, 'search');
    const box = page.locator('#q');
    await box.click();
    await page.keyboard.type('Reliance');
    await expect(box).toHaveValue('Reliance');
    await page.keyboard.press('Backspace');
    await expect(box).toHaveValue('Relianc');
    await page.keyboard.press('Enter');
    await expect(page.locator('#sStatus')).toContainText(/mentions? in/);

    const boxes = [['find', '#channels .ch input >> nth=0', 'summary:has-text("Channels and search queries")'],
      ['settings', '#dsKey'], ['settings', '#apiKey'], ['mentions', '#wl', 'summary:has-text("Edit watchlist")']];
    for (const [tab, sel, open] of boxes) {
      await page.locator(`#tabs button[data-tab="${tab}"]`).click();
      if (open) await page.click(open);
      const el = page.locator(sel);
      await el.click();
      await page.keyboard.press('Control+End'); // end of the whole text, also in the multi-line watchlist
      await page.keyboard.type('xyz');
      await expect(el, `typing in ${sel}`).toHaveValue(/xyz$/);
    }
  });

  test('stock mentions table, click-through to search, watchlist save', async ({ page }) => {
    const sent = await open(page, 'mentions');
    await page.fill('#mFrom', '2026-10-12');
    await page.fill('#mTo', '2026-10-16');
    await page.click('#mGo');
    await expect(page.locator('#mStatus')).toContainText(/names mentioned across \d+ transcripts/);
    await expect(page.locator('#mTable th.heat')).toHaveCount(5); // one column per day
    const first = page.locator('#mTable .stock-link').first();
    const name = await first.textContent();
    await first.click();
    await expect(page.locator('#tab-search')).toBeVisible();
    await expect(page.locator('#sStatus')).toContainText(`matched ${name}`);

    // Watchlist editor: bad JSON is refused, good JSON is sent (intercepted).
    await page.locator('#tabs button[data-tab="mentions"]').click();
    await page.click('summary:has-text("Edit watchlist")');
    await expect(page.locator('#wl')).toHaveValue(/"symbol":"RELIANCE"/);
    const original = await page.locator('#wl').inputValue();
    await page.fill('#wl', '{ not json');
    await page.click('#wlSave');
    await expect(page.locator('#wlStatus')).toContainText('Not saved');
    await page.fill('#wl', original);
    await page.click('#wlSave');
    await expect(page.locator('#wlStatus')).toHaveText('Saved.');
    expect(sent.watchlist[0].watchlist.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------- calls
test.describe('Calls', () => {
  test('built-in rules: calls, channel scorecard, action filter, CSV', async ({ page }) => {
    await open(page, 'calls');
    await page.fill('#cFrom', '2026-10-12');
    await page.fill('#cTo', '2026-10-16');
    await page.selectOption('#cSource', 'rules');
    await expect(page.locator('#cStatus')).toContainText('found by the built-in rules');
    await expect(page.locator('#cTable tbody tr').first()).toBeVisible();
    await expect(page.locator('#scAnalystCard')).toBeHidden(); // rules can't name analysts reliably here
    expect(await page.locator('#scChannel tbody tr').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#cAnalyze')).toBeHidden();

    await page.selectOption('#cAction', 'sell');
    await expect(page.locator('#cStatus')).toContainText(/call/);
    const actions = await page.locator('#cTable tbody .pill.buy, #cTable tbody .pill.sell').allTextContents();
    expect(actions.every(a => a === 'sell')).toBe(true);

    await page.selectOption('#cAction', '');
    const csv = await download(page, () => page.click('#cCsv'));
    expect(csv.name).toBe('calls_2026-10-12_2026-10-16.csv');
    expect(csv.body.toString().split('\n')[0]).toContain('"NSE symbol"');
  });

  test('AI source: shows AI calls; cost box appears and "Not now" spends nothing', async ({ page }) => {
    const sent = await open(page, 'calls');
    await page.fill('#cFrom', '2026-10-16');
    await page.fill('#cTo', '2026-10-16');
    await page.click('#cGo');
    await expect(page.locator('#cStatus')).toContainText('found by AI');
    await expect(page.locator('#scAnalystCard')).toBeVisible();

    await page.fill('#cFrom', '2026-09-14');
    await page.fill('#cTo', '2026-09-18');
    await page.click('#cGo');
    await expect(page.locator('#cStatus')).toContainText(/not been read by the AI yet|found by AI/);
    await page.click('#cAnalyze');
    const modal = page.locator('#modal');
    if (await shows(modal, 30_000)) {
      await expect(page.locator('#modalText')).toContainText('estimated cost');
      await expect(page.locator('#modalYes')).toContainText('Analyse');
      await page.click('#modalNo');
      await expect(modal).toBeHidden();
    }
    expect(sent.analyze).toEqual([]);
  });
});

// ---------------------------------------------------------------- analyst report
test.describe('Analyst report', () => {
  test('week picker maps ISO weeks to Monday–Friday', async ({ page }) => {
    await open(page, 'report');
    await page.fill('#rYear', '2026');
    await page.fill('#rWeek', '10');
    await expect(page.locator('#rFrom')).toHaveValue('2026-03-02');
    await expect(page.locator('#rTo')).toHaveValue('2026-03-06');
    await expect(page.locator('#rWeekDates')).toContainText('2 Mar 2026');
    await page.fill('#rWeek', '1');
    await expect(page.locator('#rFrom')).toHaveValue('2025-12-29'); // week 1 of 2026 starts in 2025
  });

  test('rules report for week 10: verdict, ranking, charts, downloads', async ({ page }) => {
    await open(page, 'report');
    await page.fill('#rYear', '2026');
    await page.fill('#rWeek', '10');
    await page.selectOption('#rSource', 'rules');
    await page.uncheck('#rFetch');
    await page.click('#rGo');
    await expect(page.locator('#rStatus')).toContainText('8 transcripts over 4 trading days');
    await expect(page.locator('#rVerdict li').first()).toContainText('Best performer');
    await expect(page.locator('#rTable tbody tr.rank1')).toHaveCount(1);
    expect(await page.locator('svg.spark').count()).toBeGreaterThan(10);
    // Clicking an analyst jumps to their call list.
    await page.locator('#rTable tbody tr.rank1 a').click();
    await expect(page.locator('#an-0')).toBeInViewport();

    const zip = await download(page, () => page.click('#rZip'));
    expect(zip.name).toBe('subtitles_txt_2026-03-02_to_2026-03-06.zip');
    const csv = await download(page, () => page.click('#rCsv'));
    expect(csv.name).toBe('analyst_report_2026-03-02_2026-03-06.csv');
    expect(csv.body.toString()).toContain('"Return %"');
  });

  test('AI report: cost box, "Not now" builds the report without spending', async ({ page }) => {
    const sent = await open(page, 'report');
    await page.fill('#rYear', '2026');
    await page.fill('#rWeek', '38');
    await page.uncheck('#rFetch');
    await page.click('#rGo');
    const modal = page.locator('#modal');
    const asked = await shows(modal, 60_000);
    if (asked) {
      await expect(page.locator('#modalText')).toContainText('have not been read by the AI yet');
      await page.keyboard.press('Escape'); // Escape = Not now
    }
    await expect(page.locator('#rStatus')).toContainText('14 Sept 2026 – 18 Sept 2026');
    if (asked) await expect(page.locator('#rStatus')).toContainText('You chose "Not now"');
    expect(sent.analyze).toEqual([]);
  });
});

// ---------------------------------------------------------------- summaries
test.describe('Summaries', () => {
  test('rules summaries show tone, top stocks and calls', async ({ page }) => {
    await open(page, 'summaries');
    await page.fill('#yFrom', '2026-10-16');
    await page.fill('#yTo', '2026-10-16');
    await page.selectOption('#ySource', 'rules');
    // Zee Business and CNBC Awaaz at least (plus any channels you've added).
    await expect(page.locator('#yStatus')).toContainText(/\d+ streams/);
    expect(await page.locator('.sumcard').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.sumcard', { hasText: 'Zee Business' })).toHaveCount(1);
    await expect(page.locator('.sumcard').first()).toContainText('Overall tone');
    await expect(page.locator('.sumcard').first()).toContainText('Most discussed stocks');
  });

  test('AI summary of 16 Oct Zee Business with working time links', async ({ page }) => {
    await open(page, 'summaries');
    await page.fill('#yFrom', '2026-10-16');
    await page.fill('#yTo', '2026-10-16');
    await page.selectOption('#yChannel', 'Zee Business');
    await page.click('#yGo');
    const card = page.locator('.sumcard').first();
    await expect(card).toContainText('Market view');
    await expect(card).toContainText('Key points');
    const hrefs = await card.locator('a.tlink').evaluateAll(as => as.map(a => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(10);
    expect(hrefs.every(h => /&t=\d+s$/.test(h))).toBe(true); // no NaN from bracketed times
    await expect(page.locator('#yAnalyze')).toBeVisible();
  });
});

// ---------------------------------------------------------------- daily auto-run
test('Daily auto-run: status, holidays, turn on/off and run now (intercepted)', async ({ page }) => {
  const sent = await open(page, 'daily');
  await expect(page.locator('#taskInfo')).toContainText(/On\.|Off\./);
  await expect(page.locator('#holSource')).toContainText('Source:');
  expect(await page.locator('#holBody tr').count()).toBeGreaterThanOrEqual(20);
  await expect(page.locator('#holBody')).toContainText('Dussehra');

  await page.fill('#taskTime', '21:15');
  await page.click('#install');
  await page.click('#remove');
  await page.click('#runNow');
  await expect.poll(() => sent.schedule.length).toBe(3);
  expect(sent.schedule[0]).toEqual({ action: 'install', time: '21:15' });
  expect(sent.schedule.map(s => s.action)).toEqual(['install', 'remove', 'run-now']);
});

// ---------------------------------------------------------------- settings
test('Settings: provider, models and key buttons (saves intercepted)', async ({ page }) => {
  const sent = await open(page, 'settings');
  await expect(page.locator('#aiProvider')).toHaveValue(/claude|deepseek/);
  const provider = await page.locator('#aiProvider').inputValue();
  const modelIds = await page.locator('#aiModel option').evaluateAll(os => os.map(o => o.value));
  expect(modelIds.length).toBeGreaterThan(0);
  expect(modelIds.every(id => id.startsWith(provider === 'deepseek' ? 'deepseek' : 'claude'))).toBe(true);

  // Empty key: refused in the page, nothing sent.
  await page.click('#saveDsKey');
  await expect(page.locator('#dsKeyStatus')).toContainText('Paste the key');
  expect(sent.settings).toEqual([]);

  // A key is sent to the app (intercepted here, so the real key is unchanged).
  await page.fill('#dsKey', 'sk-test-not-a-real-key');
  await page.click('#saveDsKey');
  await expect.poll(() => sent.settings.length).toBe(1);
  expect(sent.settings[0]).toEqual({ deepseekKey: 'sk-test-not-a-real-key' });

  await page.click('#saveAi');
  await expect(page.locator('#aiSaveStatus')).toHaveText('Saved.');
  expect(sent.settings[1]).toHaveProperty('autoAnalyze');
});

// ---------------------------------------------------------------- server safety
test('server rejects bad file paths and bad requests', async ({ request }) => {
  expect((await request.get('/files/..%2Fserver.mjs')).status()).toBe(400);
  expect((await request.get('/files/evil.exe')).status()).toBe(400);
  expect((await request.post('/api/zip', { data: { files: ['x'], ext: 'exe' } })).status()).toBe(400);
  expect((await request.get('/api/nope')).status()).toBe(404);
  const s = await (await request.get('/api/settings')).json();
  expect(JSON.stringify(s)).not.toMatch(/sk-[A-Za-z0-9]{10,}/); // keys never leave the server
});
