import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(`${process.env.TEMP}/${process.argv[2]}`, 'utf8'));
for (const want of process.argv.slice(3)) {
  const x = r.find((y) => y.route === want);
  console.log(`\n########## ${want}  [${x.status}] ##########`);
  console.log(x.text.replace(/\n{2,}/g, '\n').slice(0, 1400));
}
