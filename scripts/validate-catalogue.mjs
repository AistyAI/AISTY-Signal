// Sanity-checks catalogue/ai-vendors.json (run in CI).
import fs from 'node:fs';

const catalogue = JSON.parse(fs.readFileSync(new URL('../catalogue/ai-vendors.json', import.meta.url), 'utf8'));
const ids = new Set();
const errors = [];
for (const v of catalogue.vendors) {
  if (!v.id || !v.name || !v.category || !Array.isArray(v.emailDomains)) errors.push(`Missing fields: ${JSON.stringify(v)}`);
  if (ids.has(v.id)) errors.push(`Duplicate id: ${v.id}`);
  ids.add(v.id);
  for (const d of v.emailDomains ?? []) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) errors.push(`${v.id}: invalid domain "${d}"`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`${ids.size} vendors OK`);
