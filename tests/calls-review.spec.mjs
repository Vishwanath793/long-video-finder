// Rule-based calls: real statements from saved transcripts that the old rules misread or dropped silently,
// and the "Needs review" list on the Calls tab. Read-only.
import { test, expect } from '@playwright/test';
import { loadLibrary } from '../subtitles.mjs';
import { extractRuleCallsDetailed, REVIEW_REASONS } from '../rules.mjs';

const sec = t => t.split(':').reduce((a, n) => a * 60 + Number(n), 0);
async function around(iso, channel, time) {
  const e = (await loadLibrary()).find(x => x.iso === iso && x.channel === channel);
  const r = await extractRuleCallsDetailed(e);
  const near = x => Math.abs(sec(x.time) - sec(time)) <= 40;
  return { calls: r.calls.filter(near), review: r.review.filter(near), all: r };
}

test.describe('rule-based calls', () => {
  test('"खरीदारी की राय … शॉर्ट टर्म" is a buy, and a short watchlist name is recognised', async () => {
    // "एमफेसिस पे खरीदारी की राय है शॉर्ट टर्म … टारगेट ₹2400" — "शॉर्ट टर्म" is short term, not "short".
    const { calls } = await around('2026-10-13', 'Zee Business', '2:01:43');
    expect(calls.map(c => [c.action, c.symbol, c.target])).toContainEqual(['buy', 'MPHASIS', 2400]);
  });

  test('stock levels after "निफ्टी" are not index levels', async () => {
    // "भारत इलेक्ट्रॉनिक्स … 386 का स्टॉप लॉस और 365 के बड़े टारगेट … एसटीबीटी"
    const { calls } = await around('2026-10-07', 'CNBC Awaaz', '3:35:18');
    expect(calls.map(c => [c.action, c.symbol, c.target, c.stop_loss])).toContainEqual(['sell', 'BEL', 365, 386]);
  });

  test('a stock named right after its levels is found', async () => {
    // "… 730 का स्टॉप लॉस 820 और 850 के टारगेट्स इंडियन होटल्स में आते हुए"
    const { calls } = await around('2026-10-19', 'Zee Business', '1:53:52');
    expect(calls.map(c => c.symbol)).toContain('INDHOTEL');
  });

  test('options, commodities and promos are labelled, not called and not dropped', async () => {
    expect((await around('2026-10-06', 'CNBC Awaaz', '1:12:40')).review.map(r => r.reason)).toContain('option'); // CDSL 1280 CE
    expect((await around('2026-09-30', 'CNBC Awaaz', '8:50:58')).review.map(r => r.reason)).toContain('commodity'); // copper
    const promo = await around('2026-09-24', 'CNBC Awaaz', '3:55:03'); // "… टारगेट ₹32 … कमाई का अड्डा"
    expect(promo.calls).toHaveLength(0);
    expect(promo.review.map(r => r.reason)).toContain('repeated_segment');
  });

  test('every statement that is not a call says why, with time and quote', async () => {
    const { all } = await around('2026-10-16', 'Zee Business', '0:00:00');
    expect(all.calls.length).toBeGreaterThan(5);
    for (const r of all.review) {
      expect(REVIEW_REASONS[r.reason], r.reason).toBeTruthy();
      expect(r.time).toMatch(/^\d+:\d\d:\d\d$/);
      expect(r.quote.length).toBeGreaterThan(10);
    }
    for (const c of all.calls) expect(['buy', 'sell', 'hold']).toContain(c.action);
  });
});

test.describe('Needs review (Calls tab)', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
  });
  test.afterEach(() => expect(errors, 'no errors in the page').toEqual([]));

  test('lists un-understood calls with reasons, filter re-asks the server', async ({ page }) => {
    const asked = [];
    await page.route('**/api/calls?*', r => {
      const u = new URL(r.request().url());
      asked.push(u.searchParams.get('reason'));
      const item = (reason, extra = {}) => ({ reason, time: '1:12:40', quote: 'CDSL जिसमें हम 1280 का सीई बाय कर सकते हैं', iso: '2026-10-06',
        channel: 'CNBC Awaaz', link: 'https://www.youtube.com/watch?v=x&t=10s', action: 'buy', target: 37, stop_loss: 29, likely: 0, ...extra });
      r.fulfill({ json: { calls: [], scorecard: { byAnalyst: [], byChannel: [] }, review: {
        reasons: { option: 'An options trade', no_stock: 'No company name was recognised' }, counts: { option: 1, no_stock: 1 },
        likely: 1, total: 2, matching: 1, shown: 1,
        items: u.searchParams.get('reason') === 'option'
          ? [item('option', { candidates: [{ symbol: 'CDSL', name: 'Central Depository Services', close: 1263.4 }] })]
          : [item('no_stock', { likely: 4, quote: 'खरीदारी की जा सकती है पहला टारगेट 1525 स्टॉप लॉस 1480' })] } } });
    });
    await page.goto('/');
    await page.locator('#tabs button[data-tab="calls"]').click();
    await page.selectOption('#cSource', 'rules');
    await expect(page.locator('#rvOut')).toBeVisible();
    await expect(page.locator('#rvReason option')).toHaveText(['Likely calls (1)', 'Options trades (1)', 'No stock recognised (1)', 'Everything (2)']);
    await expect(page.locator('#rvTable')).toContainText('पहला टारगेट 1525');
    await page.selectOption('#rvReason', 'option');
    await expect(page.locator('#rvTable')).toContainText('Central Depository Services');
    await expect(page.locator('#rvTable')).toContainText('₹1,263.4');
    expect(asked).toContain('option');
  });
});
