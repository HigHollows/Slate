/** Date/heure d'une formule (UTC). `time` : l'heure est significative. */
export interface FDate {
  t: 'date';
  ms: number;
  time: boolean;
}
export type Value = number | string | boolean | null | FDate | Value[];

export type FormulaErrorCode =
  | 'syntax' // expression mal formée
  | 'name' // fonction ou propriété inconnue
  | 'type' // types incompatibles
  | 'arity' // mauvais nombre d'arguments
  | 'range' // valeur hors limites (division par zéro…)
  | 'limit' // expression trop grande / trop profonde / trop longue à évaluer
  | 'cycle'; // propriétés qui se référencent mutuellement

/** Seule classe d'erreur levée par le moteur : tout autre échec est un bug. */
export class FormulaError extends Error {
  constructor(
    readonly code: FormulaErrorCode,
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

export const isDate = (v: Value): v is FDate =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'date';
