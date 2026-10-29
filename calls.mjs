// Checks extracted stock calls against NSE daily prices and builds analyst / channel scorecards.
import { getBhav, tradingDaysAfter } from './prices.mjs';
import { loadAllAnalyses } from './ai.mjs';
import { loadAllRuleResults, REVIEW_REASONS } from './rules.mjs';

const HORIZONS = [1, 5, 20];

// Daily bars only: if target and stop-loss fall inside the same day's range we can't tell which came first,
// so that day counts as a stop-loss (the cautious reading).
export async function evaluateCall(call, iso) {
  const out = { status: 'no_price', entryUsed: null, returns: {}, hitOn: null, lastPrice: null };
  if (!call.symbol || !['buy', 'sell'].includes(call.action)) {
    out.status = !call.symbol ? 'no_symbol' : 'not_tradable';
    return out;
  }
  const dayOf = await getBhav(iso).catch(() => null);
  const bar0 = dayOf?.[call.symbol];
  // The morning shows start around 7:30–8:00, so a call in the first 90 minutes of the stream is made before
  // the 9:15 open: it's priced at that day's open and the whole call day counts. Later calls are priced at the
  // close and checked from the next day (we only have daily prices, not the moment of the call).
  const streamMin = (call.time || '0:0:0').split(':').reduce((a, n) => a * 60 + Number(n), 0) / 60;
  const preMarket = streamMin < 90;
  // Levels far from the stock's real price that day are option premiums or index levels misfiled as a stock.
  if (bar0) {
    const off = v => v != null && Math.abs(v - bar0.c) / bar0.c > (call.timeframe === 'long_term' ? 1 : 0.4);
    if (off(call.target) || off(call.stop_loss) || (call.entry != null && (call.entry < bar0.l * 0.9 || call.entry > bar0.h * 1.1))) {
      out.status = 'levels_mismatch';
      return out;
    }
  }
  const entry = call.entry || (preMarket ? bar0?.o : bar0?.c);
  if (!entry) return out;
  out.entryUsed = entry;
  out.entryBasis = call.entry ? 'said on air' : preMarket ? 'day open' : 'day close';
  const dir = call.action === 'buy' ? 1 : -1;
  // A target or stop-loss already on the wrong side of the entry price can't be judged fairly.
  if ((call.target != null && dir * (call.target - entry) <= 0) || (call.stop_loss != null && dir * (call.stop_loss - entry) >= 0)) {
    out.status = 'levels_passed';
    return out;
  }
  const intraday = call.timeframe === 'intraday';
  const maxDays = intraday ? 0 : Math.max(...HORIZONS);
  const days = await tradingDaysAfter(iso, maxDays);

  const bars = [];
  if ((intraday || preMarket) && bar0) bars.push({ iso, ...bar0 });
  for (const d of days) {
    const b = (await getBhav(d).catch(() => null))?.[call.symbol];
    if (b) bars.push({ iso: d, ...b });
  }
  out.status = 'open';
  for (const b of bars) {
    const hitT = call.target != null && (dir > 0 ? b.h >= call.target : b.l <= call.target);
    const hitS = call.stop_loss != null && (dir > 0 ? b.l <= call.stop_loss : b.h >= call.stop_loss);
    if (hitS) { out.status = 'sl_hit'; out.hitOn = b.iso; break; }
    if (hitT) { out.status = 'target_hit'; out.hitOn = b.iso; break; }
  }
  const pct = price => +(dir * (price - entry) / entry * 100).toFixed(2);
  const next = bars.filter(b => b.iso !== iso);
  for (const h of HORIZONS) if (next[h - 1]) out.returns[h] = pct(next[h - 1].c);
  if (intraday && bar0) out.returns[0] = pct(bar0.c);
  const last = bars.at(-1);
  if (last) { out.lastPrice = last.c; out.returnNow = pct(last.c); }
  if (out.status === 'open' && intraday && bar0) out.status = 'closed_eod';
  // Neither level hit within the full 20-day window: the call is over, valued at the last close.
  if (out.status === 'open' && days.length >= maxDays) out.status = 'expired';

  // What following the call would have made: exit at target or stop-loss if hit, else at the last close we have
  // (20 trading days at most, or the day's close for intraday calls).
  if (out.status === 'target_hit') out.realized = pct(call.target);
  else if (out.status === 'sl_hit') out.realized = pct(call.stop_loss);
  else if (last) out.realized = out.returnNow;

  // Price path for the mini chart: the call day, then each following trading day.
  out.series = [...(bar0 && !bars.some(b => b.iso === iso) ? [{ iso, ...bar0 }] : []), ...bars].map(b => [b.iso, b.h, b.l, b.c]);
  return out;
}

const avg = xs => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null;
const inr = n => (n >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');

// Analyst ranking for a period: who would have made the most following their calls with ₹10,000 each.
export async function analystReport({ from, to, channel, source = 'rules', perCall = 10000 } = {}) {
  const { calls } = await listCalls({ from, to, channel, source });
  const tradable = calls.filter(c => ['buy', 'sell'].includes(c.action) && c.eval.realized != null);

  // A first name alone ("सिद्धार्थ") joins the full name it belongs to ("सिद्धार्थ राय मंगला") when that's the only match.
  const fullNames = [...new Set(tradable.map(c => c.analyst).filter(n => n && n.includes(' ')))];
  const nameOf = c => {
    if (!c.analyst) return '(not named)';
    if (c.analyst.includes(' ')) return c.analyst;
    const m = fullNames.filter(f => f.split(' ')[0] === c.analyst || f.split(' ').at(-1) === c.analyst);
    return m.length === 1 ? m[0] : c.analyst;
  };

  const groups = new Map();
  for (const c of tradable) {
    const k = nameOf(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const analysts = [...groups].map(([name, cs]) => {
    const decided = cs.filter(c => ['target_hit', 'sl_hit'].includes(c.eval.status));
    const hits = decided.filter(c => c.eval.status === 'target_hit').length;
    const rs = cs.map(c => c.eval.realized);
    const best = cs.reduce((a, b) => (b.eval.realized > a.eval.realized ? b : a));
    const worst = cs.reduce((a, b) => (b.eval.realized < a.eval.realized ? b : a));
    return {
      name, channels: [...new Set(cs.map(c => c.channel))], calls: cs.length, targetHit: hits, slHit: decided.length - hits,
      open: cs.length - decided.length, hitRate: decided.length ? Math.round(100 * hits / decided.length) : null,
      avgReturn: avg(rs), winRate: Math.round(100 * rs.filter(r => r > 0).length / rs.length),
      pnl: Math.round(rs.reduce((a, r) => a + perCall * r / 100, 0)),
      best: { stock: best.stock, symbol: best.symbol, realized: best.eval.realized },
      worst: { stock: worst.stock, symbol: worst.symbol, realized: worst.eval.realized },
      callList: cs,
    };
  });

  // Ranked by average return per call; people with a single call are listed but not ranked.
  const MIN = 2;
  const ranked = analysts.filter(a => a.name !== '(not named)' && a.calls >= MIN).sort((a, b) => b.avgReturn - a.avgReturn || b.hitRate - a.hitRate);
  const others = analysts.filter(a => !ranked.includes(a)).sort((a, b) => b.calls - a.calls);
  ranked.forEach((a, i) => { a.rank = i + 1; });

  const line = a => `${a.name} (${a.channels.join(', ')}): ${a.calls} calls, ${a.targetHit} hit target, ${a.slHit} hit stop-loss, ${a.open} hit neither; ` +
    `average ${a.avgReturn > 0 ? '+' : ''}${a.avgReturn}% per call, ${inr(a.pnl)} on ${'₹' + perCall.toLocaleString('en-IN')} a call.`;
  const verdict = [];
  if (!tradable.length) verdict.push('No calls with prices to check in this period.');
  else if (!ranked.length) verdict.push(`No analyst made ${MIN} or more checkable calls in this period, so there is no ranking. See the list below.`);
  else {
    verdict.push(`Best performer: ${line(ranked[0])} Best call: ${ranked[0].best.stock} ${ranked[0].best.realized > 0 ? '+' : ''}${ranked[0].best.realized}%.`);
    if (ranked[1]) verdict.push(`Runner-up: ${line(ranked[1])}`);
    if (ranked.length > 2) verdict.push(`Weakest: ${line(ranked.at(-1))} Worst call: ${ranked.at(-1).worst.stock} ${ranked.at(-1).worst.realized}%.`);
    const all = tradable.map(c => c.eval.realized);
    verdict.push(`Across all ${tradable.length} checkable calls the average was ${avg(all) > 0 ? '+' : ''}${avg(all)}% per call (${inr(all.reduce((a, r) => a + perCall * r / 100, 0))} in total).`);
    const open = tradable.filter(c => c.eval.status === 'open').length;
    const expired = tradable.filter(c => c.eval.status === 'expired').length;
    if (open) verdict.push(`${open} calls are still running (less than 20 trading days old); they are valued at the latest close, so the ranking can still change.`);
    if (expired) verdict.push(`${expired} calls hit neither target nor stop-loss within 20 trading days and are valued at the close on day 20.`);
    const unnamed = groups.get('(not named)')?.length || 0;
    if (unnamed) verdict.push(`${unnamed} calls could not be tied to a person and are left out of the ranking.`);
  }

  return { from, to, source, perCall, minCalls: MIN, totalCalls: calls.length, checkable: tradable.length,
    analysts: [...ranked, ...others], verdict };
}

// source: 'rules' (free, built in) or 'ai' (Claude).
export async function listCalls({ from, to, channel, source = 'rules', reason = '', limit = 200 } = {}) {
  const rows = [];
  const results = source === 'ai' ? await loadAllAnalyses({ from, to, channel }) : await loadAllRuleResults({ from, to, channel });
  for (const { entry, analysis } of results) {
    for (const c of analysis.calls) {
      const sec = c.time.split(':').reduce((a, n) => a * 60 + Number(n), 0);
      rows.push({ ...c, iso: entry.iso, date: entry.date, channel: entry.channel,
        link: `${entry.url}&t=${Math.max(0, sec - 5)}s`, eval: await evaluateCall(c, entry.iso) });
    }
  }
  rows.sort((a, b) => b.iso.localeCompare(a.iso) || a.time.localeCompare(b.time, undefined, { numeric: true }));
  return { calls: rows, scorecard: { byAnalyst: score(rows, r => r.analyst || '(not named)'), byChannel: score(rows, r => r.channel) },
    review: source === 'ai' ? null : reviewList(results, { reason, limit: Number(limit) || 200 }) };
}

// Call-like statements the rules couldn't turn into a call, most likely real calls first: a stated buy/sell with
// both levels, then with one level, then the rest. Returns counts per reason and the first `limit` items.
function reviewList(results, { reason, limit }) {
  const items = [];
  for (const { entry, analysis } of results) {
    for (const r of analysis.review || []) {
      const sec = r.time.split(':').reduce((a, n) => a * 60 + Number(n), 0);
      // Explained kinds (index, commodity, option, past call, promo) aren't missed stock calls.
      const explained = ['index', 'commodity', 'option', 'past', 'repeated_segment'].includes(r.reason);
      const likely = explained ? 0 : (['buy', 'sell'].includes(r.action) ? 2 : 0) + (r.target != null && r.stop_loss != null ? 2 : r.target != null || r.stop_loss != null ? 1 : 0);
      items.push({ ...r, likely, iso: entry.iso, date: entry.date, channel: entry.channel, link: `${entry.url}&t=${Math.max(0, sec - 5)}s` });
    }
  }
  const counts = {};
  for (const r of items) counts[r.reason] = (counts[r.reason] || 0) + 1;
  const likelyCount = items.filter(r => r.likely >= 4).length;
  const pick = reason === 'all' ? items : reason ? items.filter(r => r.reason === reason) : items.filter(r => r.likely >= 4);
  pick.sort((a, b) => b.likely - a.likely || b.iso.localeCompare(a.iso) || a.time.localeCompare(b.time, undefined, { numeric: true }));
  return { reasons: REVIEW_REASONS, counts, likely: likelyCount, total: items.length, shown: Math.min(limit, pick.length), matching: pick.length, items: pick.slice(0, limit) };
}

function score(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    if (!['buy', 'sell'].includes(r.action)) continue;
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups].map(([name, rs]) => {
    const withLevels = rs.filter(r => r.target != null || r.stop_loss != null);
    const decided = withLevels.filter(r => ['target_hit', 'sl_hit'].includes(r.eval.status));
    const hits = decided.filter(r => r.eval.status === 'target_hit').length;
    const r5 = rs.map(r => r.eval.returns[5]).filter(v => v != null);
    return {
      name, calls: rs.length, withLevels: withLevels.length, decided: decided.length, targetHit: hits,
      slHit: decided.length - hits, hitRate: decided.length ? Math.round(100 * hits / decided.length) : null,
      avg5d: r5.length ? +(r5.reduce((a, b) => a + b, 0) / r5.length).toFixed(2) : null, n5d: r5.length,
    };
  }).sort((a, b) => b.calls - a.calls);
}
