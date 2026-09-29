import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(`${process.env.TEMP}/${process.argv[2]}`, 'utf8'));
for (const x of r) {
  const p = [];
  if (x.textLen < 1200) p.push(`THIN ${x.textLen}ch`);
  if (x.thrown.length) p.push(`THROWN`);
  if (x.bad.length) p.push(`BAD ${[...new Set(x.bad)].slice(0,3).join(' ')}`);
  if (x.repeated.length) p.push(`REP ${x.repeated.join(' ')}`);
  if (x.overflow > 2) p.push(`OVF ${x.overflow}`);
  if (x.loadingCount > 2) p.push(`LOADING x${x.loadingCount}`);
  if (x.deadLinks.length) p.push(`DEAD ${[...new Set(x.deadLinks)].slice(0,4).join('/')}`);
  console.log(`${String(x.route).padEnd(38)} ${String(x.status).padEnd(4)} ${String(x.textLen).padStart(6)}ch  ${p.join(' | ')}`);
}
