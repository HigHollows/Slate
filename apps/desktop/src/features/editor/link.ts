/**
 * Validation des liens. Un lien n'est accepté que s'il est : http(s), mailto avec adresse valide, ou un lien interne
 * vers une page de Slate (`slate://page/<uuid-v7>`). Tout le reste (javascript:, data:, file:, vbscript:, schémas
 * déguisés par des espaces ou des caractères de contrôle…) est refusé, à la saisie comme au collage.
 */

export const MAX_LINK = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
// Caractères de contrôle, espaces, caractères invisibles et séparateurs de ligne (construit par chaîne pour rester lisible).
const CONTROL_OR_SPACE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0020\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]',
);
const DOMAIN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?::\d{2,5})?(?:[/?#]\S*)?$/;

export const pageLink = (id: string) => `slate://page/${id}`;

/** Identifiant de la page visée par un lien interne, sinon `null`. */
export function internalPageId(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const m = /^slate:\/\/page\/([0-9a-f-]{36})$/.exec(href);
  return m && UUID.test(m[1]!) ? m[1]! : null;
}

export function isExternalHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length > MAX_LINK || CONTROL_OR_SPACE.test(href))
    return false;
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      return (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        u.hostname !== '' &&
        !u.username &&
        !u.password
      );
    } catch {
      return false;
    }
  }
  if (/^mailto:/i.test(href))
    return EMAIL.test(decodeURIComponent(href.slice(7).split('?')[0] ?? ''));
  return false;
}

/** Vrai pour un lien que l'éditeur accepte de stocker ou d'afficher. */
export const isAllowedHref = (href: unknown): boolean =>
  internalPageId(href) !== null || isExternalHref(href);

/**
 * Normalise ce que l'utilisateur a saisi : `ada@x.org` -> `mailto:ada@x.org`, `example.com/a` -> `https://example.com/a`.
 * Retourne `null` si le résultat n'est pas un lien autorisé. Les identifiants de page sont conservés tels quels.
 */
export function normalizeLink(input: string): string | null {
  const v = input.trim();
  if (v === '' || v.length > MAX_LINK) return null;
  if (isAllowedHref(v)) return v;
  if (EMAIL.test(v)) return `mailto:${v}`;
  if (DOMAIN.test(v) && !CONTROL_OR_SPACE.test(v)) {
    const candidate = `https://${v}`;
    return isExternalHref(candidate) ? candidate : null;
  }
  return null;
}

/** Texte affiché par défaut pour un lien sans texte (adresse lisible). */
export function displayForHref(href: string): string {
  if (/^mailto:/i.test(href)) return href.slice(7).split('?')[0] ?? href;
  return href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
