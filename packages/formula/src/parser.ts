import { FormulaError } from './types';

export const LIMITS = {
  maxLength: 2000,
  maxNodes: 500,
  maxDepth: 40,
  maxSteps: 20_000,
  maxString: 100_000,
} as const;

export type Ast =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'call'; name: string; args: Ast[]; pos: number }
  | { k: 'un'; op: '-' | '!'; arg: Ast; pos: number }
  | { k: 'bin'; op: string; l: Ast; r: Ast; pos: number };

type Tok =
  | { t: 'num'; v: number; pos: number }
  | { t: 'str'; v: string; pos: number }
  | { t: 'id'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'end'; pos: number };

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdStart = (c: string) => /\p{L}|_/u.test(c);
const isIdPart = (c: string) => /\p{L}|\p{N}|_/u.test(c);
const OPS3 = new Set<string>();
const OPS2 = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const OPS1 = new Set(['+', '-', '*', '/', '%', '<', '>', '!', '(', ')', ',', '?', ':']);
void OPS3;

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m?.[0] ?? c;
      const v = Number(text);
      if (!Number.isFinite(v)) throw new FormulaError('syntax', `Nombre invalide : ${text}`, i);
      out.push({ t: 'num', v, pos: i });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new FormulaError('syntax', 'Texte non terminé', i);
        const d = src[j] as string;
        if (d === c) break;
        if (d === '\\') {
          const n = src[j + 1];
          if (n === undefined) throw new FormulaError('syntax', 'Échappement incomplet', j);
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
          continue;
        }
        s += d;
        j++;
        if (s.length > LIMITS.maxString) throw new FormulaError('limit', 'Texte trop long', i);
      }
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdPart(src[j] as string)) j++;
      out.push({ t: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) {
      out.push({ t: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if (OPS1.has(c)) {
      out.push({ t: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new FormulaError('syntax', `Caractère inattendu « ${c} »`, i);
  }
  out.push({ t: 'end', pos: src.length });
  return out;
}

// Priorités (plus grand = lie plus fort). `?:` est traité à part (priorité la plus basse).
const BIN_PREC = new Map<string, number>([
  ['||', 1],
  ['&&', 2],
  ['==', 3],
  ['!=', 3],
  ['<', 4],
  ['<=', 4],
  ['>', 4],
  ['>=', 4],
  ['+', 5],
  ['-', 5],
  ['*', 6],
  ['/', 6],
  ['%', 6],
]);

export interface Parsed {
  ast: Ast;
  /** Noms de propriétés référencés littéralement par `prop("…")`. */
  refs: string[];
}

/** Analyse une expression. Ne lève que des `FormulaError`. Aucune exécution de code. */
export function parse(src: string): Parsed {
  if (src.length > LIMITS.maxLength)
    throw new FormulaError('limit', `Formule trop longue (${LIMITS.maxLength} caractères maximum)`);
  if (src.trim() === '') throw new FormulaError('syntax', 'Formule vide');
  const toks = lex(src);
  let p = 0;
  let nodes = 0;
  const refs = new Set<string>();
  const peek = () => toks[p] as Tok;
  const next = () => toks[p++] as Tok;
  const isOp = (t: Tok, v: string) => t.t === 'op' && t.v === v;
  const count = () => {
    if (++nodes > LIMITS.maxNodes) throw new FormulaError('limit', 'Formule trop complexe');
  };

  function expr(depth: number): Ast {
    if (depth > LIMITS.maxDepth)
      throw new FormulaError('limit', 'Formule trop imbriquée', peek().pos);
    const cond = binary(0, depth + 1);
    if (isOp(peek(), '?')) {
      const q = next();
      const a = expr(depth + 1);
      if (!isOp(peek(), ':'))
        throw new FormulaError('syntax', '« : » attendu dans la condition', peek().pos);
      next();
      const b = expr(depth + 1);
      count();
      return { k: 'call', name: 'if', args: [cond, a, b], pos: q.pos };
    }
    return cond;
  }

  function binary(minPrec: number, depth: number): Ast {
    if (depth > LIMITS.maxDepth)
      throw new FormulaError('limit', 'Formule trop imbriquée', peek().pos);
    let left = unary(depth + 1);
    for (;;) {
      const t = peek();
      if (t.t !== 'op') break;
      const prec = BIN_PREC.get(t.v);
      if (prec === undefined || prec <= minPrec) break;
      next();
      const right = binary(prec, depth + 1);
      count();
      left = { k: 'bin', op: t.v, l: left, r: right, pos: t.pos };
    }
    return left;
  }

  function unary(depth: number): Ast {
    if (depth > LIMITS.maxDepth)
      throw new FormulaError('limit', 'Formule trop imbriquée', peek().pos);
    const t = peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) {
      next();
      const arg = unary(depth + 1);
      count();
      return { k: 'un', op: t.v, arg, pos: t.pos };
    }
    return primary(depth + 1);
  }

  function primary(depth: number): Ast {
    const t = next();
    count();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'str':
        return { k: 'str', v: t.v };
      case 'id': {
        if (isOp(peek(), '(')) {
          next();
          const args: Ast[] = [];
          if (!isOp(peek(), ')')) {
            for (;;) {
              args.push(expr(depth + 1));
              if (isOp(peek(), ',')) {
                next();
                continue;
              }
              break;
            }
          }
          if (!isOp(peek(), ')'))
            throw new FormulaError('syntax', 'Parenthèse fermante attendue', peek().pos);
          next();
          if (t.v === 'prop') {
            const a = args[0];
            if (args.length !== 1 || a?.k !== 'str')
              throw new FormulaError(
                'syntax',
                'prop() attend un nom de propriété entre guillemets',
                t.pos,
              );
            refs.add(a.v);
          }
          return { k: 'call', name: t.v, args, pos: t.pos };
        }
        const lower = t.v.toLowerCase();
        if (lower === 'true') return { k: 'bool', v: true };
        if (lower === 'false') return { k: 'bool', v: false };
        if (lower === 'null') return { k: 'null' };
        throw new FormulaError(
          'name',
          `« ${t.v} » inconnu : les propriétés se lisent avec prop("Nom")`,
          t.pos,
        );
      }
      case 'op':
        if (t.v === '(') {
          const e = expr(depth + 1);
          if (!isOp(peek(), ')'))
            throw new FormulaError('syntax', 'Parenthèse fermante attendue', peek().pos);
          next();
          return e;
        }
        throw new FormulaError('syntax', `« ${t.v} » inattendu`, t.pos);
      default:
        throw new FormulaError('syntax', 'Expression incomplète', t.pos);
    }
  }

  const ast = expr(0);
  if (peek().t !== 'end') throw new FormulaError('syntax', 'Fin d’expression attendue', peek().pos);
  return { ast, refs: [...refs] };
}
