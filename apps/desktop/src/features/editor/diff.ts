export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string };

export const MAX_DIFF_LINES = 4000;

/**
 * Différence ligne à ligne (plus longue sous-suite commune). Retourne `null` si l'un des textes est trop long :
 * l'appelant affiche alors un message plutôt que de bloquer l'interface.
 */
export function diffLines(before: string, after: string): DiffOp[] | null {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // Préfixe / suffixe communs : le cas le plus fréquent, en O(n).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const mid = (xs: string[], s: number, e: number) => xs.slice(s, e);
  const x = mid(a, start, endA);
  const y = mid(b, start, endB);
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffOp[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: x[i++]! });
    else out.push({ kind: 'add', text: y[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: x[i++]! });
  while (j < m) out.push({ kind: 'add', text: y[j++]! });
  for (const text of a.slice(endA)) out.push({ kind: 'same', text });
  return out;
}

export const diffSummary = (ops: DiffOp[]) => ({
  added: ops.filter((o) => o.kind === 'add').length,
  removed: ops.filter((o) => o.kind === 'del').length,
});
