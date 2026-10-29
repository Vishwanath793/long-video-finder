// NSE end-of-day prices from the daily bhavcopy, cached one JSON per day in data/prices/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { unzipFirst } from './zip.mjs';
import { getHolidays, isWeekend } from './holidays.mjs';
import { dateRange } from './finder.mjs';

const DIR = new URL('./data/prices/', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: '*/*', Referer: 'https://www.nseindia.com/' };
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'SM', 'ST']);

const memo = new Map();

// { SYMBOL: { o, h, l, c } } for one trading day, or null if NSE has no file (holiday / not published yet).
export async function getBhav(iso) {
  if (memo.has(iso)) return memo.get(iso);
  const file = new URL(`${iso}.json`, DIR);
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    memo.set(iso, data);
    return data;
  } catch {}
  const ymd = iso.replaceAll('-', '');
  const res = await fetch(`https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${ymd}_F_0000.csv.zip`, { headers: HEADERS });
  // NSE's archive answers a missing day's file (holiday, not published yet) with 404 or 403.
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`NSE bhavcopy for ${iso}: HTTP ${res.status}`);
  const csv = unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8').trim().split(/\r?\n/);
  const head = csv[0].split(',');
  const col = name => head.indexOf(name);
  const [cSym, cSer, cO, cH, cL, cC] = ['TckrSymb', 'SctySrs', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric'].map(col);
  const data = {};
  for (const line of csv.slice(1)) {
    const f = line.split(',');
    if (!EQUITY_SERIES.has(f[cSer]) || data[f[cSym]]) continue;
    data[f[cSym]] = { o: +f[cO], h: +f[cH], l: +f[cL], c: +f[cC] };
  }
  await mkdir(DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  memo.set(iso, data);
  return data;
}

// Trading days strictly after `iso`, up to `count` of them, never past today.
export async function tradingDaysAfter(iso, count) {
  const { holidays } = await getHolidays();
  const end = new Date(iso + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + count * 2 + 15);
  const today = new Date().toLocaleDateString('en-CA');
  const last = end.toISOString().slice(0, 10) < today ? end.toISOString().slice(0, 10) : today;
  if (last <= iso) return [];
  return dateRange(iso, last).slice(1).filter(d => !isWeekend(d) && !holidays[d]).slice(0, count);
}

let equityList = null;
// [{ symbol, name }] for every NSE-listed equity; refreshed weekly.
export async function getEquityList() {
  if (equityList) return equityList;
  const file = new URL('equity_list.json', DIR);
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - cached.fetchedAt < 7 * 864e5) return (equityList = cached.list);
  } catch {}
  const res = await fetch('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', { headers: HEADERS });
  if (!res.ok) throw new Error(`NSE equity list: HTTP ${res.status}`);
  const list = (await res.text()).trim().split(/\r?\n/).slice(1).map(l => {
    const [symbol, name] = l.split(',');
    return { symbol, name };
  });
  await mkdir(DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), list }));
  return (equityList = list);
}

const simplify = s => (s || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(ltd|limited|the|india|industries|company|co|corporation|corp|of)\b/g, ' ').replace(/[^a-z0-9]+/g, '');

// Turns Claude's best-guess symbol and company name into a real NSE symbol, or null.
export async function resolveSymbol(symbol, name) {
  const list = await getEquityList();
  const sym = (symbol || '').toUpperCase().replace(/\s+/g, '');
  if (sym && list.some(e => e.symbol === sym)) return sym;
  const n = simplify(name);
  if (!n) return null;
  const exact = list.find(e => simplify(e.name) === n);
  if (exact) return exact.symbol;
  const starts = list.filter(e => simplify(e.name).startsWith(n));
  return starts.length === 1 ? starts[0].symbol : null;
}
