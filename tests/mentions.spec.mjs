// Stock-mention accuracy on real saved transcripts (read-only), plus the "Improve accuracy" helpers in the browser.
import { test, expect } from '@playwright/test';
import { search, mentions, suggestSpellings, untrackedStocks } from '../analysis.mjs';

test.describe('mention accuracy', () => {
  test('ads and jingles are not mentions', async () => {
    const r = await search({ q: 'JIO', limit: 100000 });
    // The jingle "Jio Jio Jio Jio Jio" and recurring ad blocks never show up as counted mentions.
    // (\W can't be used here: in JavaScript every Devanagari letter counts as \W.)
    const onlyJio = t => { const w = t.toLowerCase().replace(/\[[^\]]*\]|[।|,.!?]/g, ' ').split(/\s+/).filter(Boolean);
      return w.length >= 3 && w.every(x => /^(jio|जियो|जिओ)$/.test(x)); };
    expect(r.hits.filter(h => onlyJio(h.text))).toHaveLength(0);
    const sbi = await search({ q: 'SBIN', limit: 100000 });
    expect(sbi.hits.filter(h => /प्रायोजक|म्यूच्यूल फंड द्वारा|सेलिब्रेशंस अनलिमिटेड/.test(h.text))).toHaveLength(0);
  });

  test('a name repeated within 10 seconds counts once', async () => {
    const r = await search({ q: 'NIFTY', from: '2026-10-16', to: '2026-10-16', limit: 100000 });
    const byTranscript = new Map();
    for (const h of r.hits) {
      const prev = byTranscript.get(h.title);
      if (prev !== undefined) expect(h.seconds - prev).toBeGreaterThanOrEqual(9); // seconds are rounded down
      byTranscript.set(h.title, h.seconds);
    }
  });

  test('sister companies and mixed-script names go to the right stock', async () => {
    expect((await search({ q: 'sbi लाइफ', limit: 1 })).stock.symbol).toBe('SBILIFE');
    expect((await search({ q: 'lic हाउसिंग', limit: 1 })).stock.symbol).toBe('LICHSGFIN');
    expect((await search({ q: 'lnt finance', limit: 1 })).stock.symbol).toBe('LTF');
    expect((await search({ q: 'hdfc amc', limit: 1 })).stock.symbol).toBe('HDFCAMC');
    // Phrases marked "not a stock" are plain text searches, never counted for the bank inside them.
    expect((await search({ q: 'आईटीसी क्लेम', limit: 1 })).stock).toBeNull();
  });

  test('caption misspellings are counted; look-alike words are not', async () => {
    for (const [q, sym] of [['इटरर्नल', 'ETERNAL'], ['lnt', 'LT'], ['suzzlon', 'SUZLON'], ['nstle', 'NESTLEIND'], ['sun farma', 'SUNPHARMA']]) {
      expect((await search({ q, limit: 1 })).stock?.symbol, q).toBe(sym);
    }
    // "resilience" and "tax" sound like Reliance and TCS but are different words.
    expect((await search({ q: 'रेिलियंस', limit: 1 })).stock).toBeNull();
    expect((await search({ q: 'टैक्स', limit: 1 })).stock).toBeNull();
  });

  test('frequently discussed stocks are tracked', async () => {
    const m = await mentions({ type: 'stock' });
    const tracked = new Set(m.stocks.map(s => s.symbol));
    for (const s of ['PNB', 'PERSISTENT', 'TVSMOTOR', 'INDIGO', 'POLYCAB', 'LICI']) expect(tracked.has(s), s).toBe(true);
  });

  test('helpers suggest spellings and untracked stocks with evidence', async () => {
    const s = await suggestSpellings('ETERNAL');
    for (const x of s.suggestions) {
      expect(x.business).toBeGreaterThanOrEqual(30);
      expect(s.aliases).not.toContain(x.spelling);
    }
    const u = await untrackedStocks();
    expect(Array.isArray(u.stocks)).toBe(true);
    for (const x of u.stocks) {
      expect(x.business).toBeGreaterThanOrEqual(50);
      expect(x.spellings.length).toBeGreaterThan(0);
    }
  });
});

test.describe('Improve accuracy (Stock mentions tab)', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
  });
  test.afterEach(() => expect(errors, 'no errors in the page').toEqual([]));

  test('suggest a spelling and add it (save is intercepted)', async ({ page }) => {
    const saved = [];
    await page.route('**/api/watchlist', async r => {
      if (r.request().method() !== 'PUT') return r.continue();
      saved.push(r.request().postDataJSON());
      r.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/watchlist/suggest*', r => r.fulfill({ json: { symbol: 'ETERNAL', name: 'Eternal', aliases: ['eternal'],
      suggestions: [{ spelling: 'इटर्नलl', count: 12, business: 80, everyday: false, examples: ['इटर्नलl के नतीजे आज'] }] } }));
    await page.goto('/');
    await page.locator('#tabs button[data-tab="mentions"]').click();
    await expect(page.locator('#wsSymbol option[value="ETERNAL"]')).toHaveCount(1);
    await page.selectOption('#wsSymbol', 'ETERNAL');
    await page.click('#wsSuggest');
    await expect(page.locator('#wsTable')).toContainText('इटर्नलl');
    await expect(page.locator('#wsTable')).toContainText('80%');
    await page.locator('#wsTable button[data-ws="0"]').click();
    await expect(page.locator('#wsTable button[data-ws="0"]')).toHaveText('Added');
    expect(saved).toHaveLength(1);
    expect(saved[0].watchlist.find(s => s.symbol === 'ETERNAL').aliases).toContain('इटर्नलl');
  });
});
