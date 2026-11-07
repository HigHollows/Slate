// Génère src/catalog.generated.ts depuis les SVG Papicons vendus (svg/). Reproductible : `pnpm generate`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('../svg/', import.meta.url);
const out = new URL('../src/catalog.generated.ts', import.meta.url);
const commit = readFileSync(new URL('../SOURCE_COMMIT', import.meta.url), 'utf8').trim();
const entries = [];
for (const f of readdirSync(dir)
  .filter((n) => n.endsWith('.svg'))
  .sort()) {
  const svg = readFileSync(new URL(f, dir), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 24 24';
  const paths = [...svg.matchAll(/<path\b([^>]*)\/?>/g)].map((m) => {
    const attrs = m[1] ?? '';
    const d = /\sd="([^"]+)"/.exec(` ${attrs}`)?.[1];
    if (!d) throw new Error(`${f}: path sans d`);
    return { d, evenodd: /fill-rule="evenodd"/.test(attrs) };
  });
  if (paths.length === 0) throw new Error(`${f}: aucun path`);
  entries.push([f.replace(/\.svg$/, ''), { viewBox, paths }]);
}
const body = entries
  .map(([name, v]) => `  ${JSON.stringify(name)}: ${JSON.stringify(v)},`)
  .join('\n');
writeFileSync(
  out,
  `// FICHIER GÉNÉRÉ — ne pas modifier. Source : PapillonApp/Papicons @ ${commit} (MIT).\n` +
    `export interface IconDef { viewBox: string; paths: { d: string; evenodd: boolean }[] }\n` +
    `export const CATALOG = {\n${body}\n} as const satisfies Record<string, IconDef>;\n`,
);
console.log(`${entries.length} icônes générées`);
