// Find videos and download their subtitles for a date range, skipping what's already in the library.
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { findForChannel, dateRange, DEFAULT_CHANNELS, pause } from './finder.mjs';
import { getHolidays, isWeekend } from './holidays.mjs';
import { loadLibrary, downloadForRow } from './subtitles.mjs';
import { getSettings, analyzeMany, unanalyzed } from './ai.mjs';

const DATA = new URL('./data/', import.meta.url);

// "8:49:11" -> seconds
const seconds = d => String(d || '').split(':').map(Number).reduce((a, n) => a * 60 + (n || 0), 0);

// A saved transcript counts as "already have" only if it is at least Min hours long.
export const longEnough = (entry, minHours) => seconds(entry?.duration) >= minHours * 3600;

export function localISO(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in the PC's time zone
}

// Returns one result per (date, channel): status is 'saved', 'have', 'no-video' or 'error'.
export async function collectRange(from, to, { channels = DEFAULT_CHANNELS, minHours = 7, requireDate = true,
  tradingDaysOnly = true, redownload = false, log = () => {} } = {}) {
  const { holidays } = await getHolidays();
  const results = [];
  for (const iso of dateRange(from, to)) {
    if (tradingDaysOnly && (isWeekend(iso) || holidays[iso])) {
      log(`${iso}: skipped (${holidays[iso] || 'weekend'})`);
      continue;
    }
    for (const ch of channels) {
      const lib = await loadLibrary();
      // A saved transcript only counts if it is as long as asked for: one saved while the day's stream was
      // still live (or with a lower Min hours) is short, and must not block finding the full stream.
      // If a day has several videos for this channel (e.g. one added by URL), the longest decides.
      const existing = lib.filter(e => e.iso === iso && e.channel === ch.name && e.source !== 'members')
        .sort((a, b) => seconds(b.duration) - seconds(a.duration))[0] || null;
      const shortOne = existing && !longEnough(existing, minHours) ? existing : null;
      if (!redownload && existing && !shortOne) {
        results.push({ iso, channel: ch.name, status: 'have', entry: existing });
        continue;
      }
      if (results.length) await pause(1000);
      const row = await findForChannel(iso, ch, { minHours, requireDate });
      if (!row.found) {
        if (shortOne && !row.message.startsWith('Error')) {
          row.message += `. Your library has a shorter video for this day (${shortOne.duration}), kept for now; if the full stream is still live, try again after it ends.`;
        }
        log(`${iso} ${ch.name}: ${row.message}`);
        results.push({ iso, channel: ch.name, status: row.message.startsWith('Error') ? 'error' : 'no-video', row });
        continue;
      }
      try {
        const entry = await downloadForRow(row); // replaces the short one for this day and channel
        if (shortOne && shortOne.file !== entry.file) row.note = `Replaced a shorter video (${shortOne.duration}) that was in your library.`;
        log(`${iso} ${ch.name}: saved ${entry.lines} subtitle lines from ${row.url}${shortOne ? ` (replaced a ${shortOne.duration} video)` : ''}`);
        results.push({ iso, channel: ch.name, status: 'saved', row, entry });
      } catch (err) {
        if (shortOne) err.message += ` The shorter video (${shortOne.duration}) stays in your library until this one's subtitles are ready.`;
        log(`${iso} ${ch.name}: found ${row.url} but subtitles failed: ${err.message}`);
        results.push({ iso, channel: ch.name, status: 'error', row, error: err.message });
      }
    }
  }
  return results;
}

// The scheduled job: today plus a catch-up over the last 10 days, so a day the PC was off gets filled in later.
export async function runDaily() {
  await mkdir(DATA, { recursive: true });
  const lines = [];
  const log = msg => { lines.push(msg); console.log(msg); };
  const today = localISO();
  const start = new Date(); start.setDate(start.getDate() - 10);
  log(`--- Daily run ${new Date().toLocaleString('en-IN')} ---`);
  await getHolidays({ refresh: true }).catch(() => {});
  const results = await collectRange(localISO(start), today, { log });
  const saved = results.filter(r => r.status === 'saved').length;
  log(`Done: ${saved} new transcript(s), ${results.filter(r => r.status === 'error').length} error(s).`);

  // AI analysis of any transcript from this window that hasn't been analysed yet (only if turned on in Settings).
  const settings = await getSettings();
  const model = settings.provider === 'deepseek' ? settings.deepseekModel : settings.model;
  if (settings.autoAnalyze && (settings.provider === 'deepseek' ? settings.deepseekKey : settings.apiKey)) {
    const recent = (await loadLibrary()).filter(e => e.iso >= localISO(start));
    const todo = await unanalyzed(recent);
    if (todo.length) {
      log(`Analysing ${todo.length} transcript(s) with ${model}…`);
      const job = await analyzeMany(todo, log);
      log(`AI analysis cost about $${(job.costUsd || 0).toFixed(2)} (₹${((job.costUsd || 0) * settings.usdToInr).toFixed(0)}).`);
    }
  }
  await appendFile(new URL('daily.log', DATA), lines.join('\n') + '\n\n');
  await writeFile(new URL('last-run.json', DATA), JSON.stringify({ at: new Date().toISOString(), saved, lines }, null, 2));
  return results;
}
