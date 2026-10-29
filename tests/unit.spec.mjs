// Logic tests against real saved data (no browser). Nothing here calls an AI or changes settings.
import { test, expect } from '@playwright/test';
import { humanDate, dateRange, downsubLink, DEFAULT_CHANNELS } from '../finder.mjs';
import { getHolidays, isWeekend, isTradingDay } from '../holidays.mjs';
import { getBhav, tradingDaysAfter, resolveSymbol } from '../prices.mjs';
import { makeZip, unzipFirst } from '../zip.mjs';
import { extractRuleCalls } from '../rules.mjs';
import { findHandovers, speakerAt } from '../analysts.mjs';
import { evaluateCall } from '../calls.mjs';
import { cleanTime, costOf, MODELS } from '../ai.mjs';
import { search, mentions } from '../analysis.mjs';
import { loadLibrary } from '../subtitles.mjs';

test.describe('finder', () => {
  test('dates and DownSub links', () => {
    expect(humanDate('2026-10-16')).toBe('16 October 2026');
    expect(dateRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(downsubLink('https://www.youtube.com/watch?v=8WaINwkwnRo'))
      .toBe('https://downsub.com/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D8WaINwkwnRo');
    expect(DEFAULT_CHANNELS.map(c => c.name)).toEqual(['Zee Business', 'CNBC Awaaz']);
  });
});

test.describe('NSE holidays and prices', () => {
  test('weekends and holidays', async () => {
    expect(isWeekend('2026-10-17')).toBe(true);
    expect(isWeekend('2026-10-16')).toBe(false);
    const { holidays } = await getHolidays();
    expect(holidays['2026-10-20']).toMatch(/Dussehra/);
    expect(await isTradingDay('2026-10-20')).toBe(false);
    expect(await isTradingDay('2026-10-16')).toBe(true);
  });

  test('bhavcopy prices, trading days and symbol lookup', async () => {
    const day = await getBhav('2026-10-16');
    expect(day.RELIANCE.c).toBe(1211.2);
    expect(await getBhav('2026-10-02')).toBeNull(); // Gandhi Jayanti: no file
    expect((await tradingDaysAfter('2026-10-14', 5)).slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
    expect(await resolveSymbol('', 'Larsen & Toubro')).toBe('LT');
    expect(await resolveSymbol('LNT', 'Larsen & Toubro')).toBe('LT');
    expect(await resolveSymbol('ZZZZNOPE', 'No Such Company Anywhere')).toBeNull();
  });
});

test('reading YouTube links and dates in titles', async () => {
  const { videoIdFromUrl } = await import('../subtitles.mjs');
  const { dateFromTitle } = await import('../finder.mjs');
  for (const u of ['https://www.youtube.com/watch?v=rtV5c8mPOZQ', 'https://youtu.be/rtV5c8mPOZQ?si=x', 'youtube.com/live/rtV5c8mPOZQ',
    'https://m.youtube.com/watch?v=rtV5c8mPOZQ&t=60s', 'rtV5c8mPOZQ']) expect(videoIdFromUrl(u), u).toBe('rtV5c8mPOZQ');
  expect(videoIdFromUrl('https://example.com/watch?v=rtV5c8mPOZQ')).toBeNull();
  expect(videoIdFromUrl('hello')).toBeNull();
  expect(dateFromTitle('First Trade 19th October 2026: Zee Business Live')).toBe('2026-10-19');
  expect(dateFromTitle('Market Cues | 15th Sept 2026')).toBe('2026-09-15');
  expect(dateFromTitle('Budget Special Oct 5, 2026')).toBe('2026-10-05');
  expect(dateFromTitle('Closing Bell 07-10-2026')).toBe('2026-10-07');
  expect(dateFromTitle('31st February 2026')).toBeNull();
  expect(dateFromTitle('Andrew Huberman: Become Mentally Dangerous')).toBeNull();
});

test('a short saved video does not count as "already have"', async () => {
  const { longEnough } = await import('../collector.mjs');
  expect(longEnough({ duration: '2:55:52' }, 7)).toBe(false); // saved while the 7-hour stream was still live
  expect(longEnough({ duration: '8:50:55' }, 7)).toBe(true);
  expect(longEnough({ duration: '7:00:00' }, 7)).toBe(true);
  expect(longEnough({ duration: '58:45' }, 0.5)).toBe(true);
  expect(longEnough({}, 7)).toBe(false);
});

test('zip round trip', () => {
  const data = Buffer.from('नमस्ते — hello '.repeat(500), 'utf8');
  const zip = makeZip([{ name: 'a.txt', data }]);
  expect(zip.subarray(0, 2).toString()).toBe('PK');
  expect(unzipFirst(zip).equals(data)).toBe(true);
});

test.describe('rule-based calls', () => {
  test('16 Oct Zee Business: M&M call with levels and analyst', async () => {
    const e = (await loadLibrary()).find(x => x.iso === '2026-10-16' && x.channel === 'Zee Business');
    const calls = await extractRuleCalls(e);
    const mm = calls.find(c => c.symbol === 'M&M');
    expect(mm).toMatchObject({ action: 'buy', target: 2910, stop_loss: 2835 });
    expect(mm.analyst).toMatch(/सिद्धार्थ/);
    // Everyday words must not become companies.
    expect(calls.some(c => c.heard === 'गिरावट' || c.heard === 'शानदार')).toBe(false);
  });

  test('speaker detection: handovers vs replies', () => {
    const toks = 'बताइए राजेश जी आपकी पहली पिक क्या है'.split(' ').map((w, i) => ({ w, t: i * 1000 }));
    expect(speakerAt(findHandovers(toks), toks.length, 9000)).toBe('राजेश');
    const reply = 'नमस्कार स्वाति जी देखिए बाजार'.split(' ').map((w, i) => ({ w, t: i * 1000 }));
    expect(speakerAt(findHandovers(reply), reply.length, 9000)).toBeNull();
    const intro = 'के सिद्धार्थ राय मंगला का स्वागत करते हैं गुड मॉर्निंग सिद्धार्थ जी बताइए'.split(' ').map((w, i) => ({ w, t: i * 1000 }));
    expect(speakerAt(findHandovers(intro), intro.length, 20000)).toBe('सिद्धार्थ राय मंगला');
  });
});

test.describe('call checking on prices', () => {
  test('target hit, option premiums and passed levels', async () => {
    // A call made after market hours is priced at the day's close and checked from the next day.
    const tcs = await evaluateCall({ symbol: 'TCS', action: 'buy', target: 2470, stop_loss: 2300, timeframe: 'short_term', time: '3:00:00' }, '2026-10-14');
    expect(tcs.status).toBe('target_hit');
    expect(tcs.hitOn).toBe('2026-10-16');
    expect(tcs.realized).toBeGreaterThan(0);
    expect(tcs.series.length).toBeGreaterThan(1);
    // Option premium filed as a stock call.
    const opt = await evaluateCall({ symbol: 'BPCL', action: 'sell', entry: 6, target: 13, stop_loss: 3, timeframe: 'intraday', time: '0:40:00' }, '2026-10-16');
    expect(opt.status).toBe('levels_mismatch');
    // Unknown stock.
    expect((await evaluateCall({ symbol: null, action: 'buy' }, '2026-10-16')).status).toBe('no_symbol');
  });
});

test('AI helpers: timestamp cleaning and cost', () => {
  expect(cleanTime('[0:01:09]')).toBe('0:01:09');
  expect(cleanTime('[[5:06:27]]')).toBe('5:06:27');
  expect(cleanTime('12:34')).toBe('0:12:34');
  expect(cleanTime(undefined)).toBe('0:00:00');
  expect(costOf({ input: 1e6, output: 1e6 }, 'claude-opus-5-5')).toBe(MODELS['claude-opus-5-5'].input + MODELS['claude-opus-5-5'].output);
  expect(costOf({ input: 1, output: 1, usd: 0.5 }, 'deepseek-flash')).toBe(0.5);
});

test('search and mentions over transcripts', async () => {
  const r = await search({ q: 'Reliance', from: '2026-10-16', to: '2026-10-16' });
  expect(r.stock.symbol).toBe('RELIANCE');
  expect(r.total).toBeGreaterThan(10);
  expect(r.hits[0].link).toMatch(/&t=\d+s$/);
  const m = await mentions({ from: '2026-10-16', to: '2026-10-16', type: 'stock' });
  // Jio IPO day: still the most discussed stock once the "Jio Jio Jio" jingle and ads stop counting.
  expect(m.stocks[0].symbol).toBe('JIO');
  expect(m.stocks[0].total).toBeGreaterThan(40);
});
