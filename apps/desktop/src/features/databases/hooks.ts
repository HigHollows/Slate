import { useEffect, useMemo } from 'react';
import { Evaluator, queryRows, type EngineContext } from './engine';
import { useDatabase, useDatabases, useDatabasesStore } from './context';
import { parseViewConfig, relationTarget, type Property, type Row, type ViewConfig } from './types';

/** Titres des lignes des bases liées (charge les bases cibles à la demande). */
export function useRelationTitles(
  properties: Property[] | undefined,
): (id: string) => string | undefined {
  const store = useDatabasesStore();
  const targets = useMemo(
    () => [
      ...new Set(
        (properties ?? [])
          .map((p) => (p.type === 'relation' ? relationTarget(p) : null))
          .filter((x): x is string => !!x),
      ),
    ],
    [properties],
  );
  useEffect(() => {
    for (const t of targets) void store.getState().load(t);
  }, [targets, store]);
  const dbs = useDatabases((s) => s.dbs);
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const t of targets) for (const r of dbs[t]?.rows ?? []) map.set(r.id, r.title);
    return (id: string) => map.get(id);
  }, [dbs, targets]);
}

export interface QueryState {
  properties: Property[];
  rows: Row[];
  total: number;
  ctx: EngineContext;
  evaluator: Evaluator;
  config: ViewConfig;
}

/** Résultat filtré/trié d'une vue : la source de vérité des lignes est partagée par toutes les vues. */
export function useViewQuery(dbId: string, rawConfig: unknown, search: string): QueryState | null {
  const db = useDatabase(dbId);
  const properties = db?.properties;
  const relationTitle = useRelationTitles(properties);
  const config = useMemo(() => parseViewConfig(rawConfig), [rawConfig]);
  const ctx = useMemo<EngineContext | null>(
    () => (properties ? { properties, relationTitle } : null),
    [properties, relationTitle],
  );
  const evaluator = useMemo(() => (ctx ? new Evaluator(ctx) : null), [ctx]);
  const rows = db?.rows;
  return useMemo(() => {
    if (!ctx || !evaluator || !rows || !properties) return null;
    const r = queryRows(rows, config, ctx, search, evaluator);
    return { properties, rows: r.rows, total: r.total, ctx, evaluator, config };
  }, [ctx, evaluator, rows, properties, config, search]);
}
