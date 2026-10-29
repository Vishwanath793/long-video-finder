// Command line: node cli.mjs 2026-10-16 [2026-10-20]
import { findAll } from './finder.mjs';

const [from, to] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
  console.error('Usage: node cli.mjs YYYY-MM-DD [YYYY-MM-DD]');
  process.exit(1);
}

const rows = await findAll(from, to || from);
let lastDate = '';
for (const r of rows) {
  if (r.date !== lastDate) { console.log(`\n=== ${r.date} ===`); lastDate = r.date; }
  console.log(`\n${r.channel}`);
  if (!r.found) { console.log(`  ${r.message}`); continue; }
  console.log(`  Title:    ${r.title}`);
  console.log(`  Duration: ${r.duration}`);
  console.log(`  YouTube:  ${r.url}`);
  console.log(`  DownSub:  ${r.downsub}`);
  if (r.note) console.log(`  Note:     ${r.note}`);
}
