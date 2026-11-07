// Vérifie que fr.json et en.json ont exactement les mêmes clés.
import { readFileSync } from 'node:fs';
const dir = new URL('../apps/desktop/src/shared/i18n/locales/', import.meta.url);
const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v ? flat(v, `${p}${k}.`) : [`${p}${k}`],
  );
const load = (l) => new Set(flat(JSON.parse(readFileSync(new URL(`${l}.json`, dir), 'utf8'))));
const fr = load('fr'),
  en = load('en');
const missing = [...fr]
  .filter((k) => !en.has(k))
  .map((k) => `manque en en.json: ${k}`)
  .concat([...en].filter((k) => !fr.has(k)).map((k) => `manque en fr.json: ${k}`));
if (missing.length) {
  console.error(missing.join('\n'));
  process.exit(1);
}
console.log(`i18n OK (${fr.size} clés)`);
