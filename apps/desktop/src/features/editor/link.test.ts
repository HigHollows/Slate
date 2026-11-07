import { describe, expect, it } from 'vitest';
import { displayForHref, internalPageId, isAllowedHref, normalizeLink, pageLink } from './link';

const ID = '0192f0a0-0000-7000-8000-000000000001';

describe('validation des liens', () => {
  it('accepte http(s), mailto valide et liens internes', () => {
    for (const ok of [
      'https://example.com',
      'http://example.com/a?b=1#c',
      'HTTPS://EXAMPLE.COM',
      'mailto:ada@example.com',
      'mailto:ada@example.com?subject=Bonjour',
      pageLink(ID),
    ])
      expect(isAllowedHref(ok), ok).toBe(true);
  });

  it('refuse les schémas dangereux, déguisés ou mal formés', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'java\tscript:alert(1)',
      'jav&#x61;script:alert(1)',
      '​javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com',
      'slate://page/pas-un-uuid',
      'slate://page/' + ID.toUpperCase(),
      'slate://autre/' + ID,
      'https://user:pass@example.com',
      'https://',
      'https://exa mple.com',
      'mailto:pas-une-adresse',
      'mailto:',
      '//example.com',
      'https://example.com/' + 'a'.repeat(2000),
      '',
      42,
      null,
      undefined,
    ])
      expect(isAllowedHref(bad), String(bad)).toBe(false);
  });

  it('normalise la saisie : domaine, adresse e-mail, page ; refuse le reste', () => {
    expect(normalizeLink('  example.com/chemin?x=1 ')).toBe('https://example.com/chemin?x=1');
    expect(normalizeLink('sous.domaine.fr')).toBe('https://sous.domaine.fr');
    expect(normalizeLink('localhost:3000')).toBeNull(); // pas un domaine public explicite
    expect(normalizeLink('ada@example.com')).toBe('mailto:ada@example.com');
    expect(normalizeLink(pageLink(ID))).toBe(pageLink(ID));
    for (const bad of [
      'javascript:alert(1)',
      'pas un lien',
      'a b.com',
      '',
      '   ',
      'data:text/html;base64,AAAA',
      'example.com\nfoo',
    ])
      expect(normalizeLink(bad), bad).toBeNull();
  });

  it('identifiant de page et affichage', () => {
    expect(internalPageId(pageLink(ID))).toBe(ID);
    expect(internalPageId('https://example.com')).toBeNull();
    expect(internalPageId(undefined)).toBeNull();
    expect(displayForHref('https://example.com/')).toBe('example.com');
    expect(displayForHref('mailto:ada@example.com?subject=x')).toBe('ada@example.com');
  });
});
