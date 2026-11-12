import { describe, expect, it } from 'vitest';
import { pageToMarkdown } from './markdown';

const t = (text: string, marks: { type: string; attrs?: Record<string, unknown> }[] = []) => ({
  type: 'text',
  text,
  ...(marks.length ? { marks } : {}),
});
const p = (...c: unknown[]) => ({ type: 'paragraph', content: c });
const doc = (...c: unknown[]) => JSON.stringify({ type: 'doc', content: c });

describe('export Markdown', () => {
  it('titre, paragraphes et titres de section', () => {
    const md = pageToMarkdown(
      doc({ type: 'heading', attrs: { level: 2 }, content: [t('Plan')] }, p(t('Bonjour')), p()),
      'Ma page',
    );
    expect(md).toBe('# Ma page\n\n## Plan\n\nBonjour\n');
  });
  it('marques : gras, italique, barré, code, lien — espaces de bord hors des marques', () => {
    const md = pageToMarkdown(
      doc(
        p(
          t('gras ', [{ type: 'bold' }]),
          t('it', [{ type: 'italic' }]),
          t(' bar', [{ type: 'strike' }]),
          t(' x', [{ type: 'code' }]),
          t(' site', [{ type: 'link', attrs: { href: 'https://a.fr/x y' } }]),
        ),
      ),
    );
    expect(md).toBe('**gras** *it* ~~bar~~ `x` [site](https://a.fr/x%20y)\n');
  });
  it('listes imbriquées, numérotées et cases à cocher', () => {
    const li = (...c: unknown[]) => ({ type: 'listItem', content: c });
    const md = pageToMarkdown(
      doc(
        {
          type: 'bulletList',
          content: [
            li(p(t('un')), { type: 'bulletList', content: [li(p(t('sous-un')))] }),
            li(p(t('deux'))),
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [li(p(t('trois'))), li(p(t('quatre')))],
        },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: true }, content: [p(t('fait'))] },
            { type: 'taskItem', attrs: { checked: false }, content: [p(t('à faire'))] },
          ],
        },
      ),
    );
    expect(md).toBe(
      '- un\n  - sous-un\n- deux\n\n3. trois\n4. quatre\n\n- [x] fait\n- [ ] à faire\n',
    );
  });
  it('citation, code (langue sûre, clôture adaptée), séparateur, tableau', () => {
    const md = pageToMarkdown(
      doc(
        { type: 'blockquote', content: [p(t('cité'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] },
        { type: 'codeBlock', attrs: { language: 'x" onerror' }, content: [t('```')] },
        { type: 'horizontalRule' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [p(t('A'))] },
                { type: 'tableHeader', content: [p(t('B|C'))] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [p(t('1'))] },
                { type: 'tableCell', content: [p(t('2'))] },
              ],
            },
          ],
        },
      ),
    );
    expect(md).toContain('> cité');
    expect(md).toContain('```ts\nconst a = 1;\n```');
    expect(md).toContain('~~~\n```\n~~~'); // langue refusée, clôture différente
    expect(md).toContain('---');
    expect(md).toContain('| A | B\\|C |\n| --- | --- |\n| 1 | 2 |');
  });
  it('liens dangereux supprimés, caractères Markdown échappés, blocs inconnus conservés en texte', () => {
    const md = pageToMarkdown(
      doc(
        p(t('clic', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]), t(' *non* # [x]')),
        { type: 'callout', content: [p(t('Attention'))] },
        {
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [t('Titre')] },
            { type: 'detailsContent', content: [p(t('Détail'))] },
          ],
        },
      ),
    );
    expect(md).not.toContain('javascript:');
    expect(md).toContain('clic \\*non\\* \\# \\[x\\]');
    expect(md).toContain('Attention');
    expect(md).toContain('Titre');
    expect(md).toContain('Détail');
  });
  it('JSON illisible ou vide : jamais d’exception', () => {
    expect(pageToMarkdown('pas du json', 'T')).toBe('# T\n');
    expect(pageToMarkdown('{}')).toBe('\n');
    expect(pageToMarkdown(doc(), '  ')).toBe('\n');
  });
});
