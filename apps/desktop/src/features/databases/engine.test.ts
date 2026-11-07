import { describe, expect, it } from 'vitest';
import {
  Evaluator,
  aggregate,
  countRules,
  groupRows,
  matchFilter,
  queryRows,
  type EngineContext,
} from './engine';
import { typeDef } from './registry';
import {
  DEFAULT_VIEW_CONFIG,
  parseViewConfig,
  type FilterGroup,
  type Property,
  type Row,
  type ViewConfig,
} from './types';

const P = (
  id: string,
  name: string,
  type: Property['type'],
  config: Record<string, unknown> = {},
): Property => ({ id, databaseId: 'db', name, type, config, position: id });
const opts = (...names: string[]) => ({
  options: names.map((n) => ({ id: `o-${n}`, name: n, color: 'gray' })),
});
const PROPS: Property[] = [
  P('t', 'Nom', 'title'),
  P('n', 'Prix', 'number'),
  P('s', 'Statut', 'status', opts('À faire', 'En cours', 'Terminé')),
  P('m', 'Tags', 'multiselect', opts('a', 'b', 'c')),
  P('d', 'Échéance', 'date'),
  P('c', 'Fait', 'checkbox'),
  P('x', 'Note', 'text'),
  P('f', 'Total', 'formula', { expression: 'prop("Prix") * 2' }),
];
const row = (id: string, title: string, props: Record<string, unknown> = {}): Row => ({
  id,
  databaseId: 'db',
  title,
  props,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
});
const ROWS: Row[] = [
  row('1', 'Alpha', {
    n: 10,
    s: 'o-En cours',
    m: ['o-a', 'o-b'],
    d: '2026-03-10',
    c: true,
    x: 'Réunion équipe',
  }),
  row('2', 'beta', { n: 5, s: 'o-À faire', m: ['o-c'], d: '2026-01-05', c: false, x: 'budget' }),
  row('3', 'Gamma', { n: 20, s: 'o-Terminé', d: '2026-02-20', x: 'Équipe projet' }),
  row('4', 'Delta', { s: 'o-En cours' }),
  row('5', 'Epsilon', { n: 5, m: [], c: true }),
];
const ctx: EngineContext = { properties: PROPS, now: () => Date.UTC(2026, 1, 20, 12) };
const cfg = (over: Partial<ViewConfig>): ViewConfig => ({ ...DEFAULT_VIEW_CONFIG, ...over });
const group = (op: 'and' | 'or', ...children: FilterGroup['children']): FilterGroup => ({
  type: 'group',
  id: 'r',
  op,
  children,
});
const rule = (
  propertyId: string,
  op: FilterGroup['children'][number] extends infer R
    ? R extends { op: infer O }
      ? O
      : never
    : never,
  value?: unknown,
) =>
  ({
    type: 'rule',
    id: Math.random().toString(36),
    propertyId,
    op,
    value,
  }) as FilterGroup['children'][number];
const ids = (rows: Row[]) => rows.map((r) => r.id).join(',');
const run = (c: Partial<ViewConfig>, search = '') => ids(queryRows(ROWS, cfg(c), ctx, search).rows);

describe('filtres', () => {
  it('texte : insensible à la casse et aux accents', () => {
    expect(run({ filter: group('and', rule('x', 'contains', 'equipe')) })).toBe('1,3');
    expect(run({ filter: group('and', rule('t', 'startsWith', 'BET')) })).toBe('2');
    expect(run({ filter: group('and', rule('t', 'is', 'gamma')) })).toBe('3');
    expect(run({ filter: group('and', rule('x', 'notContains', 'équipe')) })).toBe('2,4,5');
    expect(run({ filter: group('and', rule('x', 'isEmpty')) })).toBe('4,5');
    expect(run({ filter: group('and', rule('x', 'endsWith', 'projet')) })).toBe('3');
  });
  it('nombres', () => {
    expect(run({ filter: group('and', rule('n', 'gt', 5)) })).toBe('1,3');
    expect(run({ filter: group('and', rule('n', 'lte', 5)) })).toBe('2,5');
    expect(run({ filter: group('and', rule('n', 'eq', '5')) })).toBe('2,5');
    expect(run({ filter: group('and', rule('n', 'neq', 5)) })).toBe('1,3,4');
    expect(run({ filter: group('and', rule('n', 'isEmpty')) })).toBe('4');
  });
  it('sélection, statut, multi-sélection, case à cocher', () => {
    expect(run({ filter: group('and', rule('s', 'is', 'o-En cours')) })).toBe('1,4');
    expect(run({ filter: group('and', rule('s', 'isNot', 'o-En cours')) })).toBe('2,3,5');
    expect(run({ filter: group('and', rule('s', 'isEmpty')) })).toBe('5');
    expect(run({ filter: group('and', rule('m', 'contains', 'o-b')) })).toBe('1');
    expect(run({ filter: group('and', rule('m', 'notContains', 'o-b')) })).toBe('2,3,4,5');
    expect(run({ filter: group('and', rule('m', 'isEmpty')) })).toBe('3,4,5');
    expect(run({ filter: group('and', rule('c', 'checked')) })).toBe('1,5');
    expect(run({ filter: group('and', rule('c', 'unchecked')) })).toBe('2,3,4');
  });
  it('dates : exacte, relatives (aujourd’hui, jours) et bornes', () => {
    expect(run({ filter: group('and', rule('d', 'before', { mode: 'today' })) })).toBe('2'); // aujourd'hui = 2026-02-20 (exclu)
    expect(run({ filter: group('and', rule('d', 'onOrBefore', { mode: 'today' })) })).toBe('2,3');
    expect(run({ filter: group('and', rule('d', 'after', { mode: 'daysFromNow', n: -30 })) })).toBe(
      '1,3',
    );
    expect(run({ filter: group('and', rule('d', 'is', '2026-03-10')) })).toBe('1');
    expect(
      run({ filter: group('and', rule('d', 'onOrAfter', { mode: 'exact', date: '2026-02-20' })) }),
    ).toBe('1,3');
    expect(run({ filter: group('and', rule('d', 'isEmpty')) })).toBe('4,5');
  });
  it('ET / OU et groupes imbriqués', () => {
    const f = group(
      'or',
      rule('n', 'gt', 15),
      group('and', rule('c', 'checked'), rule('n', 'lt', 8)),
    );
    expect(run({ filter: f })).toBe('3,5');
    expect(
      run({
        filter: group(
          'and',
          rule('n', 'gt', 1),
          group('or', rule('t', 'is', 'alpha'), rule('t', 'is', 'beta')),
        ),
      }),
    ).toBe('1,2');
    expect(countRules(f)).toBe(3);
  });
  it('formules : filtrables selon le type du résultat', () => {
    expect(run({ filter: group('and', rule('f', 'gt', 15)) })).toBe('1,3'); // la ligne 4 (formule en erreur) ne correspond pas
  });
  it('règle sur une propriété supprimée : ignorée', () => {
    expect(run({ filter: group('and', rule('inconnue', 'is', 'x')) })).toBe('1,2,3,4,5');
  });
  it('recherche plein texte dans la vue', () => {
    expect(run({}, 'equipe')).toBe('1,3');
    expect(run({}, 'ALPHA')).toBe('1');
    expect(run({}, 'en cours')).toBe('1,4');
    expect(run({}, '20')).toBe('1,2,3'); // dates 2026-…, formule Total (10×2 = 20) : tout texte affiché est cherché
    expect(run({}, 'zzz')).toBe('');
  });
});

describe('tris', () => {
  it('simple : valeurs vides toujours en dernier, dans les deux sens', () => {
    expect(run({ sorts: [{ propertyId: 'n', direction: 'asc' }] })).toBe('2,5,1,3,4');
    expect(run({ sorts: [{ propertyId: 'n', direction: 'desc' }] })).toBe('3,1,2,5,4');
  });
  it('multiple, stable', () => {
    expect(
      run({
        sorts: [
          { propertyId: 'n', direction: 'asc' },
          { propertyId: 't', direction: 'desc' },
        ],
      }),
    ).toBe('5,2,1,3,4');
    expect(run({ sorts: [{ propertyId: 'c', direction: 'desc' }] })).toBe('1,5,2,3,4');
  });
  it('par statut : ordre des options, pas alphabétique', () => {
    expect(run({ sorts: [{ propertyId: 's', direction: 'asc' }] })).toBe('2,1,4,3,5');
  });
  it('texte : insensible à la casse, numérique ("a2" < "a10")', () => {
    const rs = [row('a', 'a10'), row('b', 'A2'), row('c', 'b1')];
    expect(
      ids(queryRows(rs, cfg({ sorts: [{ propertyId: 't', direction: 'asc' }] }), ctx).rows),
    ).toBe('b,a,c');
  });
  it('dates et formules', () => {
    expect(run({ sorts: [{ propertyId: 'd', direction: 'asc' }] })).toBe('2,3,1,4,5');
    expect(run({ sorts: [{ propertyId: 'f', direction: 'desc' }] })).toBe('3,1,2,5,4');
  });
  it('tri sur une propriété supprimée : ignoré', () => {
    expect(run({ sorts: [{ propertyId: 'zzz', direction: 'asc' }] })).toBe('1,2,3,4,5');
  });
  it('ne modifie pas le tableau d’origine', () => {
    const copy = [...ROWS];
    queryRows(ROWS, cfg({ sorts: [{ propertyId: 'n', direction: 'desc' }] }), ctx);
    expect(ROWS).toEqual(copy);
  });
});

describe('formules dans les lignes', () => {
  const ev = new Evaluator({
    properties: [
      ...PROPS,
      P('g', 'Cycle A', 'formula', { expression: 'prop("Cycle B")' }),
      P('h', 'Cycle B', 'formula', { expression: 'prop("Cycle A")' }),
      P('e', 'Erreur', 'formula', { expression: '1/0' }),
      P('b', 'Bad', 'formula', { expression: '1 +' }),
      P('r', 'Ref', 'formula', { expression: 'prop("Total") + 1' }),
    ],
    now: () => 0,
  });
  const find = (n: string) => ev['ctx'].properties.find((p) => p.name === n)!;
  it('calcule, chaîne les formules, rapporte les erreurs sans lever', () => {
    expect(ev.formula(ROWS[0]!, find('Total'))).toEqual({ ok: true, value: 20 });
    expect(ev.formula(ROWS[0]!, find('Ref'))).toEqual({ ok: true, value: 21 });
    expect(ev.formula(ROWS[3]!, find('Total'))).toMatchObject({ ok: false }); // Prix vide * 2 : type
    expect(ev.formula(ROWS[0]!, find('Erreur'))).toMatchObject({
      ok: false,
      error: { code: 'range' },
    });
    expect(ev.formula(ROWS[0]!, find('Bad'))).toMatchObject({
      ok: false,
      error: { code: 'syntax' },
    });
  });
  it('détecte les références circulaires', () => {
    const r = ev.formula(ROWS[0]!, find('Cycle A'));
    expect(r).toMatchObject({ ok: false, error: { code: 'cycle' } });
  });
  it('lit date, sélection, multi-sélection, relation par leur nom lisible', () => {
    const e = new Evaluator({
      properties: [
        ...PROPS,
        P('z', 'Z', 'formula', {
          expression:
            'concat(prop("Statut"), "|", join(prop("Tags"), "+"), "|", formatDate(prop("Échéance")), "|", year(prop("Échéance")))',
        }),
      ],
      now: () => 0,
    });
    const z = e['ctx'].properties.find((p) => p.id === 'z')!;
    expect(e.formula(ROWS[0]!, z)).toEqual({ ok: true, value: 'En cours|a+b|2026-03-10|2026' });
  });
});

describe('regroupement', () => {
  const labels = { none: 'Sans valeur', yes: 'Oui', no: 'Non' };
  const ev = new Evaluator(ctx);
  it('par statut : ordre des options + « sans valeur »', () => {
    const g = groupRows(ROWS, PROPS[2]!, ev, labels);
    expect(g.map((x) => `${x.label}:${ids(x.rows)}`)).toEqual([
      'À faire:2',
      'En cours:1,4',
      'Terminé:3',
      'Sans valeur:5',
    ]);
  });
  it('par multi-sélection : une ligne peut figurer dans plusieurs groupes', () => {
    const g = groupRows(ROWS, PROPS[3]!, ev, labels);
    expect(g.map((x) => `${x.label}:${ids(x.rows)}`)).toEqual([
      'a:1',
      'b:1',
      'c:2',
      'Sans valeur:3,4,5',
    ]);
  });
  it('par case à cocher et par texte libre', () => {
    expect(groupRows(ROWS, PROPS[5]!, ev, labels).map((x) => `${x.label}:${ids(x.rows)}`)).toEqual([
      'Oui:1,5',
      'Non:2,3,4',
    ]);
    expect(groupRows(ROWS, PROPS[6]!, ev, labels).map((x) => x.label)).toEqual([
      'Réunion équipe',
      'budget',
      'Équipe projet',
      'Sans valeur',
    ]);
  });
});

describe('agrégations', () => {
  const ev = new Evaluator(ctx);
  const n = PROPS[1]!;
  it('nombres', () => {
    expect(aggregate(ROWS, n, 'sum', ev)).toBe(40);
    expect(aggregate(ROWS, n, 'avg', ev)).toBe(10);
    expect(aggregate(ROWS, n, 'min', ev)).toBe(5);
    expect(aggregate(ROWS, n, 'max', ev)).toBe(20);
    expect(aggregate(ROWS, n, 'median', ev)).toBe(7.5);
    expect(aggregate([], n, 'avg', ev)).toBeNull();
  });
  it('comptages et pourcentages', () => {
    expect(aggregate(ROWS, n, 'count', ev)).toBe(5);
    expect(aggregate(ROWS, n, 'countEmpty', ev)).toBe(1);
    expect(aggregate(ROWS, n, 'percentNotEmpty', ev)).toBe(80);
    expect(aggregate(ROWS, PROPS[5]!, 'checked', ev)).toBe(2);
    expect(aggregate(ROWS, PROPS[5]!, 'percentChecked', ev)).toBe(40);
    expect(aggregate(ROWS, n, 'none', ev)).toBeNull();
  });
});

describe('types de propriétés : texte ↔ valeur', () => {
  const t = (type: Property['type'], cfg?: Record<string, unknown>) => ({
    def: typeDef(type),
    p: P('p', 'p', type, cfg),
  });
  it('nombre : formats français et anglais', () => {
    const { def, p } = t('number');
    expect(def.fromText('1 234,5', p)).toBe(1234.5);
    expect(def.fromText('12.5', p)).toBe(12.5);
    expect(def.fromText('12 %', p)).toBe(12);
    expect(def.fromText('abc', p)).toBeUndefined();
    expect(def.fromText('', p)).toBeNull();
  });
  it('date : ISO ou JJ/MM/AAAA, jamais une date impossible', () => {
    const { def, p } = t('date');
    expect(def.fromText('2024-02-29', p)).toBe('2024-02-29');
    expect(def.fromText('5/3/2025', p)).toBe('2025-03-05');
    expect(def.fromText('31/02/2025', p)).toBeUndefined();
    expect(def.fromText('demain', p)).toBeUndefined();
  });
  it('sélection par nom (sans accent), multi par liste', () => {
    const s = t('select', opts('À faire', 'Fini'));
    expect(s.def.fromText('a faire', s.p)).toBe('o-À faire');
    expect(s.def.fromText('inconnu', s.p)).toBeUndefined();
    const m = t('multiselect', opts('x', 'y'));
    expect(m.def.fromText('x; y', m.p)).toEqual(['o-x', 'o-y']);
    expect(m.def.fromText('x, z', m.p)).toBeUndefined();
    expect(m.def.toText(['o-y', 'o-x'], m.p)).toBe('y, x');
  });
  it('url, e-mail, téléphone, case à cocher', () => {
    expect(t('url').def.fromText('https://a.fr', t('url').p)).toBe('https://a.fr');
    expect(t('url').def.fromText('javascript:alert(1)', t('url').p)).toBeUndefined();
    expect(t('email').def.fromText('a@b.fr', t('email').p)).toBe('a@b.fr');
    expect(t('email').def.fromText('pas un mail', t('email').p)).toBeUndefined();
    expect(t('phone').def.fromText('+33 6 12', t('phone').p)).toBe('+33 6 12');
    expect(t('checkbox').def.fromText('Oui', t('checkbox').p)).toBe(true);
    expect(t('checkbox').def.fromText('peut-être', t('checkbox').p)).toBeUndefined();
  });
  it('propriétés calculées : non éditables', () => {
    for (const k of ['formula', 'id', 'created_time', 'last_edited_time'] as const) {
      expect(typeDef(k).computed).toBe(true);
      expect(typeDef(k).fromText('x', P('p', 'p', k))).toBeUndefined();
    }
  });
});

describe('configuration de vue', () => {
  it('lecture tolérante : valeurs corrompues → défauts, sans lever', () => {
    expect(parseViewConfig(null)).toEqual(DEFAULT_VIEW_CONFIG);
    const c = parseViewConfig({
      sorts: 'x',
      widths: { a: 5, b: 200 },
      hidden: [1],
      filter: 'cassé',
      groupBy: 42,
    });
    expect(c.sorts).toEqual([]);
    expect(c.hidden).toEqual([]);
    expect(c.filter.children).toEqual([]);
    expect(c.groupBy).toBeNull();
    expect(parseViewConfig({ cardSize: 'xl' }).cardSize).toBe('m');
  });
  it('conserve une configuration valide', () => {
    const f = group('and', rule('n', 'gt', 3));
    const c = parseViewConfig({
      filter: f,
      sorts: [{ propertyId: 'n', direction: 'asc' }],
      groupBy: 's',
      hidden: ['x'],
      widths: { n: 120 },
      aggregations: { n: 'sum' },
    });
    expect(c.filter).toEqual(f);
    expect(c.aggregations).toEqual({ n: 'sum' });
    expect(
      matchFilter(c.filter, ROWS[0]!, new Map(PROPS.map((p) => [p.id, p])), new Evaluator(ctx), 0),
    ).toBe(true);
  });
});

describe('performance (100 000 lignes)', () => {
  it('filtre + tri + recherche en moins de 5 s (≈ 1-2 s au repos) ; formules évaluées à la demande', () => {
    const many: Row[] = Array.from({ length: 100_000 }, (_, i) =>
      row(String(i), `Ligne ${i}`, {
        n: (i * 7919) % 1000,
        s: `o-${['À faire', 'En cours', 'Terminé'][i % 3]}`,
        d: `2026-0${1 + (i % 9)}-1${i % 9}`,
        x: i % 10 === 0 ? 'urgent' : 'normal',
      }),
    );
    const t0 = performance.now();
    const f = group(
      'and',
      rule('n', 'gt', 500),
      group('or', rule('s', 'is', 'o-En cours'), rule('x', 'contains', 'urgent')),
    );
    const out = queryRows(
      many,
      cfg({
        filter: f,
        sorts: [
          { propertyId: 'n', direction: 'desc' },
          { propertyId: 't', direction: 'asc' },
        ],
      }),
      ctx,
    );
    const dt = performance.now() - t0;
    expect(out.rows.length).toBeGreaterThan(10_000);
    expect(out.rows[0]!.props['n']).toBe(999);
    expect(out.total).toBe(100_000);
    expect(dt, `filtre+tri 100k : ${dt.toFixed(0)} ms`).toBeLessThan(5000); // marge pour une machine chargée ; mesuré < 2 s au repos
  });
  it('chaque lecture de formule est mémoïsée', () => {
    const many: Row[] = Array.from({ length: 20_000 }, (_, i) => row(String(i), `L${i}`, { n: i }));
    const ev = new Evaluator(ctx);
    const f = PROPS[7]!;
    const t0 = performance.now();
    for (const r of many) ev.formula(r, f);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (const r of many) ev.formula(r, f);
    expect(performance.now() - t1).toBeLessThan(first + 5);
    expect(first).toBeLessThan(1500);
  });
});
