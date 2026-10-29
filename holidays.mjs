// NSE trading holidays: fetched live from nseindia.com, cached in data/holidays.json,
// with a built-in 2026 list as a fallback when NSE can't be reached.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DATA = new URL('./data/', import.meta.url);
const CACHE = new URL('holidays.json', DATA);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

const FALLBACK_2026 = {
  '2026-01-15': 'Municipal Corporation Election - Maharashtra', '2026-01-26': 'Republic Day',
  '2026-02-15': 'Mahashivratri', '2026-03-03': 'Holi', '2026-03-21': 'Id-Ul-Fitr (Ramadan Eid)',
  '2026-03-26': 'Shri Ram Navami', '2026-03-31': 'Shri Mahavir Jayanti', '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti', '2026-05-01': 'Maharashtra Day', '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram', '2026-08-15': 'Independence Day', '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti', '2026-10-20': 'Dussehra', '2026-11-08': 'Diwali Laxmi Pujan',
  '2026-11-10': 'Diwali-Balipratipada', '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev', '2026-12-25': 'Christmas',
};

async function fetchFromNSE() {
  const home = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' } });
  const cookie = home.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const res = await fetch('https://www.nseindia.com/api/holiday-master?type=trading', {
    headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie,
      Referer: 'https://www.nseindia.com/resources/exchange-communication-holidays' },
  });
  if (!res.ok) throw new Error(`NSE returned HTTP ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const h of json.CM || []) {
    const [d, m, y] = h.tradingDate.split('-'); // "20-Oct-2026"
    out[`${y}-${MON[m]}-${d}`] = h.description.replace(/\*$/, '');
  }
  if (!Object.keys(out).length) throw new Error('NSE returned no equity holidays');
  return out;
}

// Returns { 'YYYY-MM-DD': 'Holiday name' }. Refreshes from NSE at most once a week.
export async function getHolidays({ refresh = false } = {}) {
  let cached = null;
  try { cached = JSON.parse(await readFile(CACHE, 'utf8')); } catch {}
  const stale = !cached || Date.now() - cached.fetchedAt > 7 * 864e5;
  if (refresh || stale) {
    try {
      const holidays = await fetchFromNSE();
      cached = { fetchedAt: Date.now(), source: 'nseindia.com', holidays: { ...cached?.holidays, ...holidays } };
      await mkdir(DATA, { recursive: true });
      await writeFile(CACHE, JSON.stringify(cached, null, 2));
    } catch (err) {
      if (!cached) return { source: 'built-in list (NSE unreachable: ' + err.message + ')', holidays: FALLBACK_2026 };
    }
  }
  return { source: cached.source, fetchedAt: cached.fetchedAt, holidays: { ...FALLBACK_2026, ...cached.holidays } };
}

export function isWeekend(iso) {
  return [0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay());
}

export async function isTradingDay(iso) {
  if (isWeekend(iso)) return false;
  const { holidays } = await getHolidays();
  return !holidays[iso];
}
