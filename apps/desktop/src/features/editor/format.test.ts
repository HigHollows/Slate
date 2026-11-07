import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExtensions } from './extensions';
import {
  luminanceClass,
  parseCssColor,
  parseCssFontSize,
  sanitizeColor,
  sanitizeFontFamily,
  sanitizeFontSize,
} from './format';

const i18n = {
  placeholder: '',
  slashLabel: '',
  slashEmpty: '',
  mentionLabel: '',
  mentionEmpty: '',
  untitled: '',
  createPage: (t: string) => t,
  slashTitle: (id: string) => id,
  slashDescription: (id: string) => id,
  slashGroup: (g: string) => g,
  calloutLabel: (v: string) => v,
  detailsCollapse: 'Replier',
  detailsExpand: 'Déplier',
  imageMissing: 'Image introuvable',
  code: {
    language: 'Langage',
    copy: 'Copier',
    copied: 'Copié',
    copyFailed: 'Échec',
    lineNumbers: 'Numéros',
    collapse: 'Replier',
    expand: 'Déplier',
    languageName: (id: string) => id,
  },
  taskProgress: (d: number, t: number) => `${d}/${t}`,
  tocLabel: 'Sommaire',
  tocEmpty: 'Aucun titre',
  summaryPlaceholder: '',
};
const media = { upload: async () => undefined, load: async () => 'blob:x', open: () => undefined };
const editors: Editor[] = [];
function make(ydoc = new Y.Doc(), html?: string) {
  const ed = new Editor({
    extensions: buildExtensions({
      ydoc,
      i18n,
      getPages: () => [],
      createPage: async () => undefined,
      media,
    }),
  });
  editors.push(ed);
  // Avec Collaboration, le contenu initial passe par une commande (le Y.Doc est la source de vérité).
  if (html) ed.commands.setContent(html);
  return { ed, ydoc };
}
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

const marks = (ed: Editor) => JSON.stringify(ed.getJSON(), null, 0);

describe('valeurs de formatage validées', () => {
  it('couleurs : palette, #rgb, #rrggbb ; tout le reste est refusé', () => {
    expect(sanitizeColor('RED', 'text')).toBe('red');
    expect(sanitizeColor('#ABC', 'text')).toBe('#aabbcc');
    expect(sanitizeColor('#12ab9F', 'highlight')).toBe('#12ab9f');
    expect(sanitizeColor('beige', 'text')).toBeNull(); // beige n'est pas une couleur de texte
    expect(sanitizeColor('beige', 'highlight')).toBe('beige');
    for (const bad of [
      'url(javascript:alert(1))',
      'red;background:url(x)',
      'expression(1)',
      '#12',
      '#gggggg',
      42,
      null,
      '',
    ]) {
      expect(sanitizeColor(bad, 'text')).toBeNull();
    }
  });
  it('polices et tailles', () => {
    expect(sanitizeFontFamily('serif')).toBe('serif');
    expect(sanitizeFontFamily('Comic Sans; x:y')).toBeNull();
    expect(sanitizeFontSize('24')).toBe(24);
    expect(sanitizeFontSize(13.6)).toBe(14);
    for (const bad of [7, 97, 9999, -3, NaN, '12px', 'abc', null])
      expect(sanitizeFontSize(bad)).toBeNull();
  });
  it('conversion du CSS collé', () => {
    expect(parseCssColor('rgb(255, 0, 16)')).toBe('#ff0010');
    expect(parseCssColor('rgba(0,0,0,0)')).toBeNull();
    expect(parseCssColor('rgb(300,0,0)')).toBeNull();
    expect(parseCssColor('blue')).toBeNull();
    expect(parseCssFontSize('12pt')).toBe(16);
    expect(parseCssFontSize('14px')).toBe(14);
    expect(parseCssFontSize('2em')).toBeNull();
  });
  it('classe de luminance : repère les couleurs illisibles sur un des deux thèmes', () => {
    expect(luminanceClass('#000000')).toBe('low');
    expect(luminanceClass('#ffffff')).toBe('high');
    expect(luminanceClass('#808080')).toBe('mid');
  });
});

describe('formatage dans l’éditeur', () => {
  it('applique et combine gras, italique, souligné, barré, code, indice, exposant', () => {
    const { ed } = make(undefined, '<p>texte</p>');
    ed.commands.selectAll();
    ed.chain().toggleBold().toggleItalic().toggleUnderline().toggleStrike().run();
    for (const m of ['bold', 'italic', 'underline', 'strike']) expect(ed.isActive(m)).toBe(true);
    ed.chain().toggleSubscript().run();
    expect(ed.isActive('subscript')).toBe(true);
    ed.chain().toggleSuperscript().run(); // exclusif avec l'indice
    expect(ed.isActive('superscript')).toBe(true);
    expect(ed.isActive('subscript')).toBe(false);
    ed.chain().toggleBold().run();
    expect(ed.isActive('bold')).toBe(false);
  });

  it('couleur, police, taille et surlignage ne touchent que la sélection', () => {
    const { ed } = make(undefined, '<p>un deux trois</p>');
    ed.commands.setTextSelection({ from: 4, to: 8 }); // « deux »
    ed.chain()
      .setTextColor('red')
      .setFontSize(24)
      .setFontFamily('serif')
      .toggleHighlight({ color: 'pink' })
      .run();
    const html = ed.getHTML();
    expect(html).toContain('data-doc-color="red"');
    expect(html).toContain('data-doc-size="24"');
    expect(html).toContain('data-doc-font="serif"');
    expect(html).toContain('data-color="pink"');
    expect(html.match(/<span/g)?.length).toBeGreaterThan(0);
    expect(html.startsWith('<p>un <span')).toBe(true);
    expect(html.endsWith('>deux</mark></span> trois</p>')).toBe(true);
    expect(ed.getText()).toBe('un deux trois');
  });

  it('refuse les valeurs invalides sans modifier le document', () => {
    const { ed } = make(undefined, '<p>abc</p>');
    ed.commands.selectAll();
    const before = marks(ed);
    expect(ed.commands.setTextColor('url(javascript:1)')).toBe(false);
    expect(ed.commands.setFontSize(5000)).toBe(false);
    expect(ed.commands.setFontFamily('Papyrus')).toBe(false);
    expect(marks(ed)).toBe(before);
  });

  it('retire un format particulier, puis tous les formats, sans toucher au texte', () => {
    const { ed } = make(undefined, '<p>abc</p>');
    ed.commands.selectAll();
    ed.chain().toggleBold().setTextColor('blue').setFontSize(18).toggleHighlight().run();
    ed.commands.unsetTextColor();
    expect(ed.getHTML()).not.toContain('data-doc-color');
    expect(ed.getHTML()).toContain('data-doc-size="18"');
    ed.commands.clearFormatting();
    expect(ed.getHTML()).toBe('<p>abc</p>');
  });

  it('titres 1 à 6, alignement, interligne', () => {
    const { ed } = make(undefined, '<p>t</p>');
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      ed.chain().setHeading({ level }).run();
      expect(ed.isActive('heading', { level })).toBe(true);
    }
    ed.commands.setTextAlign('justify');
    expect(ed.isActive({ textAlign: 'justify' })).toBe(true);
    ed.commands.setLineHeight('1.5');
    expect(ed.getHTML()).toContain('data-line-height="1.5"');
    expect(ed.commands.setLineHeight('9')).toBe(false);
  });
});

describe('persistance : le formatage survit à l’enregistrement et à la réouverture', () => {
  it('aller-retour Yjs (docState) et JSON : rendu identique', () => {
    const { ed, ydoc } = make(undefined, '<h2>Titre</h2><p>un deux trois</p>');
    ed.commands.setTextSelection({ from: 10, to: 14 });
    ed.chain()
      .toggleBold()
      .toggleItalic()
      .setTextColor('#123abc')
      .setFontSize(20)
      .toggleHighlight({ color: 'yellow' })
      .run();
    ed.commands.setTextAlign('center');
    const json = ed.getJSON();
    const html = ed.getHTML();

    // « fermer et rouvrir » : on ne garde que les octets enregistrés
    const saved = Y.encodeStateAsUpdate(ydoc);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, saved);
    const { ed: ed2 } = make(reopened);
    expect(ed2.getJSON()).toEqual(json);
    expect(ed2.getHTML()).toBe(html);
    // et le JSON de secours (content_json) se recharge à l'identique dans un document vierge
    const { ed: ed3 } = make(new Y.Doc());
    ed3.commands.setContent(json);
    expect(ed3.getHTML()).toBe(html);
  });
});

describe('sécurité du contenu collé', () => {
  it('élimine scripts, gestionnaires d’événements, styles dangereux et URL javascript:', () => {
    const evil =
      '<p onclick="x()">a<script>alert(1)</script><img src=x onerror="alert(1)">' +
      '<span style="color:red;background:url(javascript:alert(1));font-size:9999px;position:fixed">b</span>' +
      '<a href="javascript:alert(1)">c</a><iframe src="https://evil"></iframe></p>';
    const { ed } = make(undefined, evil);
    const html = ed.getHTML();
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|iframe|position|9999/i);
    expect(ed.getText()).toContain('b');
  });
  it('convertit les styles Word/Docs compatibles et ignore le reste', () => {
    const { ed } = make(
      undefined,
      '<p><span style="color:rgb(255,0,0);font-size:12pt;font-family:Georgia, serif;line-height:3">x</span></p>',
    );
    const html = ed.getHTML();
    expect(html).toContain('data-doc-color="#ff0000"');
    expect(html).toContain('data-doc-size="16"');
    expect(html).toContain('data-doc-font="serif"');
  });
});

describe('blocs documentaires', () => {
  it('encadrés typés : variante validée, changement de type, retrait, ancien encadré sans type', () => {
    const { ed } = make(undefined, '<p>a</p>');
    ed.commands.selectAll();
    ed.commands.toggleCallout('warning');
    expect(ed.getHTML()).toContain('data-variant="warning"');
    ed.commands.setCalloutVariant('tip');
    expect(ed.getHTML()).toContain('data-variant="tip"');
    ed.commands.setCalloutVariant('<script>' as never);
    expect(ed.getHTML()).toContain('data-variant="note"'); // valeur inconnue : retombe sur « note »
    ed.commands.setTextSelection(3); // curseur dans l'encadré
    ed.commands.toggleCallout();
    expect(ed.getHTML()).not.toContain('data-callout');
    ed.commands.setContent('<div data-callout><p>ancien</p></div>');
    expect(ed.getHTML()).toContain('data-variant="note"');
    expect(ed.getText()).toContain('ancien');
  });

  it('bloc repliable : insertion, texte conservé, aller-retour', () => {
    const { ed, ydoc } = make(undefined, '<p>cache</p>');
    ed.commands.selectAll();
    expect(ed.commands.setDetails()).toBe(true);
    expect(ed.getHTML()).toContain('<details');
    expect(ed.getText()).toContain('cache');
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(make(reopened).ed.getHTML()).toBe(ed.getHTML());
  });

  it('sommaire : hiérarchie, mise à jour automatique, navigation, texte jamais interprété comme HTML', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent('<h1>Un</h1><h2>Deux &lt;img src=x onerror=1&gt;</h2><p>t</p>');
    ed.commands.insertContentAt(0, { type: 'toc' });
    const nav = ed.view.dom.querySelector('nav[data-toc]')!;
    expect(nav).toBeTruthy();
    const items = [...nav.querySelectorAll('button')];
    expect(items.map((b) => b.textContent)).toEqual(['Un', 'Deux <img src=x onerror=1>']);
    expect(nav.querySelector('img')).toBeNull();
    ed.chain()
      .insertContentAt(ed.state.doc.content.size, {
        type: 'heading',
        attrs: { level: 3 },
        content: [{ type: 'text', text: 'Trois' }],
      })
      .run();
    expect([...nav.querySelectorAll('button')].map((b) => b.textContent)).toContain('Trois');
    (nav.querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(ed.state.selection.$from.parent.textContent).toContain('Deux');
    expect(ed.getHTML()).toContain('data-toc'); // seul le bloc est stocké, pas la liste
    expect(ed.getHTML()).not.toContain('Trois</button>');
  });
});

describe('tableaux', () => {
  it('lignes, colonnes, en-têtes, fusion, division, fond de cellule, suppression', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    const count = (tag: string) =>
      (ed.getHTML().match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
    expect(count('tr')).toBe(2);
    ed.commands.addRowAfter();
    expect(count('tr')).toBe(3);
    ed.commands.addColumnAfter();
    expect(count('th') + count('td')).toBe(9);
    ed.commands.deleteRow();
    ed.commands.deleteColumn();
    expect(count('tr')).toBe(2);
    expect(count('th') + count('td')).toBe(4);
    const first: number[] = [];
    ed.state.doc.descendants(
      (n, pos) =>
        void (n.type.name.startsWith('table') && n.type.name.endsWith('ell') && first.push(pos)),
    );
    ed.commands.setTextSelection(first[0]! + 2); // cellule de la 2e ligne
    const ths = count('th');
    ed.commands.toggleHeaderColumn();
    expect(count('th')).not.toBe(ths); // la colonne d'en-tête change vraiment les cellules
    ed.commands.setCellBackground('pink');
    expect(ed.getHTML()).toContain('data-bg="pink"');
    expect(ed.commands.setCellBackground('red;x:y')).toBe(false);
    ed.commands.unsetCellBackground();
    expect(ed.getHTML()).not.toContain('data-bg');
    ed.commands.deleteTable();
    expect(ed.getHTML()).not.toContain('<table');
  });

  it('fusion de cellules, puis division', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    ed.commands.selectAll();
    // sélection de cellules : de la première à la dernière
    const cells: number[] = [];
    ed.state.doc.descendants((n, pos) => void (n.type.name === 'tableCell' && cells.push(pos)));
    ed.commands.setCellSelection({ anchorCell: cells[0]!, headCell: cells[3]! });
    expect(ed.can().mergeCells()).toBe(true);
    ed.commands.mergeCells();
    expect(ed.getHTML()).toMatch(/colspan="2"/);
    expect(ed.can().splitCell()).toBe(true);
    ed.commands.splitCell();
    expect(ed.getHTML()).not.toMatch(/colspan="2"/);
  });

  it('largeur de colonne et fond persistent après réouverture ; contenu collé nettoyé', () => {
    const { ed, ydoc } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      '<table><tr><th colwidth="120" style="background-color:red" data-bg="blue">A</th><td data-bg="javascript:1" onclick="x()">b</td></tr></table>',
    );
    const html = ed.getHTML();
    expect(html).toContain('data-bg="blue"');
    expect(html).not.toMatch(/javascript|onclick|style="background-color:red/);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(make(reopened).ed.getHTML()).toBe(html);
  });
});

const HASH = 'a'.repeat(64);
describe('images', () => {
  it('insère une image par empreinte, valide ses attributs, conserve alt/alignement/largeur', () => {
    const { ed, ydoc } = make(undefined, '<p>x</p>');
    expect(ed.commands.insertImage({ hash: 'pas-un-hash' })).toBe(false);
    expect(ed.commands.insertImage({ hash: '../../etc/passwd' })).toBe(false);
    expect(ed.commands.insertImage({ hash: HASH, alt: 'Un\nchat' })).toBe(true);
    ed.commands.updateImage({ align: 'wide', width: 50 });
    expect(ed.commands.updateImage({ align: 'bizarre' })).toBe(false);
    expect(ed.commands.updateImage({ width: 33 as never })).toBe(false);
    const html = ed.getHTML();
    expect(html).toContain(`data-hash="${HASH}"`);
    expect(html).toContain('data-alt="Un chat"');
    expect(html).toContain('data-align="wide"'); // les valeurs refusées ne modifient rien
    expect(html).toContain('data-width="50"');
    expect(html).not.toMatch(/src=|base64|data:image/);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(make(reopened).ed.getHTML()).toBe(html);
  });
  it('HTML collé : pas de <img src>, hash invalide refusé, légende conservée', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      `<figure data-image data-hash="${HASH}" data-width="75"><figcaption>Légende</figcaption></figure>` +
        '<figure data-image data-hash="javascript:alert(1)"><figcaption>b</figcaption></figure>' +
        '<img src="https://evil.example/x.png" onerror="alert(1)">',
    );
    const html = ed.getHTML();
    expect(html).toContain('Légende');
    expect(html).toContain(`data-hash="${HASH}"`);
    expect(html).not.toMatch(/javascript:|evil\.example|onerror/);
  });
});

describe('blocs de code', () => {
  it('langage validé, numéros de ligne, repli, aller-retour', () => {
    const { ed, ydoc } = make(undefined, '<p>x</p>');
    ed.commands.setContent('<pre><code>const a = 1;\nfn()</code></pre>');
    ed.commands.setTextSelection(3);
    expect(ed.commands.setCodeLanguage('rust')).toBe(true);
    expect(ed.getHTML()).toContain('data-language="rust"');
    ed.commands.setCodeLanguage('<script>');
    expect(ed.getHTML()).toContain('data-language="plaintext"');
    ed.commands.setCodeLanguage('typescript');
    ed.commands.toggleCodeLineNumbers();
    ed.commands.toggleCodeCollapsed();
    const html = ed.getHTML();
    expect(html).toContain('data-line-numbers="true"');
    expect(html).toContain('data-collapsed="true"');
    expect(ed.getText()).toContain('const a = 1;');
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(make(reopened).ed.getHTML()).toBe(html);
    ed.commands.toggleCodeLineNumbers();
    expect(ed.getHTML()).not.toContain('data-line-numbers');
  });
  it('le code reste du texte : HTML dans un bloc de code non interprété', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      '<pre><code>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;1&lt;/script&gt;</code></pre>',
    );
    expect(ed.view.dom.querySelector('img')).toBeNull();
    expect(ed.view.dom.querySelector('script')).toBeNull();
    expect(ed.getText()).toContain('<img src=x onerror=alert(1)>');
  });
  it('coloration syntaxique : jetons produits pour chaque langage pris en charge', async () => {
    const { lowlight, CODE_LANGUAGES } = await import('./CodeBlock');
    const samples: Record<string, string> = {
      javascript: 'const a = 1;',
      typescript: 'let a: number = 1;',
      html: '<a href="x">y</a>',
      css: 'a { color: red; }',
      json: '{"a": 1}',
      python: 'def f(): return 1',
      rust: 'fn main() { let x = 1; }',
      sql: 'SELECT * FROM t;',
      bash: 'echo "hi"',
      markdown: '# Titre',
      yaml: 'a: 1',
      java: 'class A { int x = 1; }',
      c: 'int main() { return 0; }',
      cpp: 'int main() { return 0; }',
    };
    for (const lang of CODE_LANGUAGES.filter((l) => l !== 'plaintext')) {
      const tree = lowlight.highlight(lang, samples[lang]!);
      expect(JSON.stringify(tree), lang).toContain('hljs-');
    }
  });
});

describe('recherche et remplacement', () => {
  const state = (ed: Editor) =>
    import('./SearchReplace').then((m) => m.searchKey.getState(ed.state)!);

  it('trouve à travers les marques de mise en forme, respecte casse et mots entiers', async () => {
    const { ed } = make(
      undefined,
      '<p>Chat chat <strong>CH</strong>at écharpe</p><p>un chat. chats, CHAT</p>',
    );
    ed.commands.setSearch({ term: 'chat' });
    expect((await state(ed)).matches).toHaveLength(6); // Chat, chat, CH+at (marques), écharpe n'en contient pas, chat, chats, CHAT
    ed.commands.setSearch({ caseSensitive: true });
    expect((await state(ed)).matches).toHaveLength(3); // chat (1), chat, chats
    ed.commands.setSearch({ caseSensitive: false, wholeWord: true });
    expect((await state(ed)).matches).toHaveLength(5); // sans « chats »
    ed.commands.setSearch({ term: 'écharpe', wholeWord: true });
    expect((await state(ed)).matches).toHaveLength(1);
    ed.commands.setSearch({ term: 'char', wholeWord: true });
    expect((await state(ed)).matches).toHaveLength(0); // « écharpe » : lettre accentuée avant, pas une limite de mot
    ed.commands.clearSearch();
    expect((await state(ed)).matches).toHaveLength(0);
  });

  it('les caractères spéciaux sont cherchés littéralement (pas d’expression régulière)', async () => {
    const { ed } = make(undefined, '<p>a.b (c) [d] a+b $1 a*b</p>');
    for (const [term, n] of [
      ['.', 1],
      ['(c)', 1],
      ['[d]', 1],
      ['a+b', 1],
      ['$1', 1],
      ['a*b', 1],
      ['.*', 0],
    ] as const) {
      ed.commands.setSearch({ term });
      expect((await state(ed)).matches, term).toHaveLength(n);
    }
    expect(ed.commands.setSearch({ term: 'x'.repeat(501) })).toBe(false);
  });

  it('navigation circulaire, sélection de l’occurrence', async () => {
    const { ed } = make(undefined, '<p>a b a b a</p>');
    ed.commands.setSearch({ term: 'a' });
    expect((await state(ed)).current).toBe(0);
    ed.commands.findNext();
    ed.commands.findNext();
    expect((await state(ed)).current).toBe(2);
    ed.commands.findNext();
    expect((await state(ed)).current).toBe(0); // retour au début
    ed.commands.findPrev();
    expect((await state(ed)).current).toBe(2);
    expect(ed.state.selection.from).toBe((await state(ed)).matches[2]!.from);
  });

  it('remplace une occurrence, puis toutes, en conservant la mise en forme et en restant annulable', async () => {
    const { ed } = make(undefined, '<p>chat <strong>chat</strong> chat</p>');
    ed.commands.setSearch({ term: 'chat' });
    ed.commands.findNext(); // 2e : en gras
    ed.commands.replaceCurrent('chien');
    expect(ed.getHTML()).toBe('<p>chat <strong>chien</strong> chat</p>');
    ed.commands.replaceAll('lion');
    expect(ed.getHTML()).toBe('<p>lion <strong>chien</strong> lion</p>');
    expect(ed.commands.replaceAll('x')).toBe(false);
    ed.commands.undo(); // Yjs regroupe les modifications rapprochées : l'état d'avant le remplacement revient
    expect(ed.getText()).not.toBe('lion chien lion');
  });

  it('les remplacements se recalculent quand le document change et ne boucle pas si le texte contient le terme', async () => {
    const { ed } = make(undefined, '<p>a a a</p>');
    ed.commands.setSearch({ term: 'a' });
    ed.commands.replaceAll('aa');
    expect(ed.getText()).toBe('aa aa aa');
    expect((await state(ed)).matches).toHaveLength(6);
  });

  it('le calcul des occurrences reste rapide sur un long document', async () => {
    const { findMatches } = await import('./SearchReplace');
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      Array.from({ length: 5000 }, (_, i) => `<p>Paragraphe ${i} avec un mot cherché</p>`).join(''),
    );
    const t0 = performance.now();
    const found = findMatches(ed.state.doc, {
      term: 'cherché',
      caseSensitive: false,
      wholeWord: false,
    });
    expect(found).toHaveLength(5000);
    // Mesure du seul calcul (le rendu des surlignages sous jsdom, bien plus lent qu'un navigateur, n'est pas chronométré).
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

const T1 = '0192f0a0-0000-7000-8000-000000000001';
const T2 = '0192f0a0-0000-7000-8000-000000000002';
describe('ancrage des commentaires', () => {
  it('l’ancrage suit le texte quand le document évolue', async () => {
    const { anchoredThreadIds, commentRange } = await import('./CommentAnchor');
    const { ed } = make(undefined, '<p>un deux trois</p>');
    ed.commands.setTextSelection({ from: 4, to: 8 }); // « deux »
    expect(ed.commands.setCommentThread(T1)).toBe(true);
    const text = () => {
      const r = commentRange(ed.state.doc, T1)!;
      return ed.state.doc.textBetween(r.from, r.to);
    };
    expect(text()).toBe('deux');
    ed.commands.insertContentAt(1, 'AVANT '); // texte inséré avant
    expect(text()).toBe('deux');
    ed.commands.insertContentAt(ed.state.doc.content.size - 1, ' APRES');
    expect(text()).toBe('deux');
    // texte tapé juste après la fin de l'ancrage : l'ancrage ne s'étend pas
    const r = commentRange(ed.state.doc, T1)!;
    ed.commands.insertContentAt(r.to, 'X');
    expect(text()).toBe('deux');
    // texte tapé à l'intérieur : l'ancrage s'étend
    ed.commands.insertContentAt(r.from + 2, 'Y');
    expect(text()).toBe('deYux');
    expect(anchoredThreadIds(ed.state.doc)).toEqual(new Set([T1]));
  });

  it('modifications concurrentes (Yjs) : les deux copies convergent et gardent l’ancrage sur les mêmes mots', async () => {
    const { commentRange } = await import('./CommentAnchor');
    const a = make(undefined, '<p>alpha beta gamma</p>');
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.ydoc));
    const b = make(docB);
    // chaque copie envoie ses mises à jour à l'autre, avec un décalage contrôlé
    const pendingA: Uint8Array[] = [];
    const pendingB: Uint8Array[] = [];
    a.ydoc.on(
      'update',
      (u: Uint8Array, origin: unknown) => origin !== 'remote' && pendingA.push(u),
    );
    b.ydoc.on(
      'update',
      (u: Uint8Array, origin: unknown) => origin !== 'remote' && pendingB.push(u),
    );
    // A commente « beta » ; en parallèle B insère du texte avant et dans le passage
    a.ed.commands.setTextSelection({ from: 7, to: 11 });
    a.ed.commands.setCommentThread(T1);
    b.ed.commands.insertContentAt(1, 'DEBUT ');
    b.ed.commands.insertContentAt(b.ed.state.doc.content.size - 1, ' FIN');
    pendingA.forEach((u) => Y.applyUpdate(b.ydoc, u, 'remote'));
    pendingB.forEach((u) => Y.applyUpdate(a.ydoc, u, 'remote'));
    expect(a.ed.getHTML()).toBe(b.ed.getHTML());
    for (const e of [a.ed, b.ed]) {
      const r = commentRange(e.state.doc, T1)!;
      expect(e.state.doc.textBetween(r.from, r.to)).toBe('beta');
    }
  });

  it('supprimer le texte ancré fait disparaître l’ancrage ; un fil se retire seul', async () => {
    const { anchoredThreadIds } = await import('./CommentAnchor');
    const { ed } = make(undefined, '<p>aaa bbb ccc</p>');
    ed.commands.setTextSelection({ from: 1, to: 4 });
    ed.commands.setCommentThread(T1);
    ed.commands.setTextSelection({ from: 5, to: 8 });
    ed.commands.setCommentThread(T2);
    expect(anchoredThreadIds(ed.state.doc)).toEqual(new Set([T1, T2]));
    ed.commands.removeCommentThread(T1);
    expect(anchoredThreadIds(ed.state.doc)).toEqual(new Set([T2]));
    expect(ed.getText()).toBe('aaa bbb ccc'); // le texte reste intact
    ed.commands.deleteRange({ from: 5, to: 8 });
    expect(anchoredThreadIds(ed.state.doc).size).toBe(0);
  });

  it('fils qui se chevauchent, identifiants invalides refusés', async () => {
    const { anchoredThreadIds } = await import('./CommentAnchor');
    const { ed } = make(undefined, '<p>abcdef</p>');
    ed.commands.setTextSelection({ from: 1, to: 5 });
    ed.commands.setCommentThread(T1);
    ed.commands.setTextSelection({ from: 3, to: 7 });
    ed.commands.setCommentThread(T2);
    expect(anchoredThreadIds(ed.state.doc)).toEqual(new Set([T1, T2]));
    expect(ed.commands.setCommentThread('x" onmouseover="1')).toBe(false);
    expect(ed.commands.setCommentThread(T1.toUpperCase())).toBe(false);
    expect(ed.getHTML()).not.toMatch(/onmouseover/);
  });

  it('copier-coller et HTML importé : aucun commentaire n’est dupliqué', async () => {
    const { anchoredThreadIds } = await import('./CommentAnchor');
    const { ed } = make(undefined, '<p>début</p>');
    // jsdom n'a pas de ClipboardEvent : on applique la transformation de collage de l'éditeur à la tranche analysée.
    const { DOMParser: PMParser } = await import('@tiptap/pm/model');
    const holder = document.createElement('div');
    holder.innerHTML = `<p>collé <span data-comment-thread="${T1}">commenté</span></p>`;
    const slice = PMParser.fromSchema(ed.schema).parseSlice(holder);
    expect(
      anchoredThreadIds(ed.schema.nodes['doc']!.create(null, slice.content as never)).size,
    ).toBe(1); // la marque est bien lue
    let pasted = slice;
    // comme ProseMirror : toutes les transformations de collage s'appliquent, l'une après l'autre
    ed.view.someProp('transformPasted', (f) => {
      pasted = f(pasted, ed.view, false);
    });
    expect(pasted.content.textBetween(0, pasted.content.size)).toContain('commenté');
    expect(
      anchoredThreadIds(ed.schema.nodes['doc']!.create(null, pasted.content as never)).size,
    ).toBe(0);
    // HTML chargé par setContent (ex. restauration de version) : seuls les identifiants valides sont gardés
    ed.commands.setContent(
      `<p><span data-comment-thread="${T2}">ok</span> <span data-comment-thread="pas-valide">non</span></p>`,
    );
    expect(anchoredThreadIds(ed.state.doc)).toEqual(new Set([T2]));
  });

  it('aller-retour Yjs : l’ancrage est conservé à la réouverture', async () => {
    const { anchoredThreadIds } = await import('./CommentAnchor');
    const { ed, ydoc } = make(undefined, '<p>garder ce passage</p>');
    ed.commands.setTextSelection({ from: 8, to: 11 });
    ed.commands.setCommentThread(T1);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(anchoredThreadIds(make(reopened).ed.state.doc)).toEqual(new Set([T1]));
  });
});

describe('collage', () => {
  const paste = async (
    html: string,
    mode: 'auto' | 'keep' | 'compatible' = 'auto',
    start = '<p>x</p>',
  ) => {
    const { pasteHtml } = await import('./SmartPaste');
    const { ed } = make(undefined, start);
    ed.commands.selectAll();
    pasteHtml(ed, html, mode);
    return ed;
  };

  it('détecte la source', async () => {
    const { detectSource, effectiveMode } = await import('./paste');
    expect(detectSource('<p class="MsoNormal">a<o:p></o:p></p>')).toBe('word');
    expect(detectSource('<b id="docs-internal-guid-1234">x</b>')).toBe('docs');
    expect(detectSource('<p data-pm-slice="1 1 []">x</p>')).toBe('slate');
    expect(detectSource('<p>x</p>')).toBe('web');
    expect(effectiveMode('auto', 'web')).toBe('compatible');
    expect(effectiveMode('auto', 'word')).toBe('keep');
    expect(effectiveMode('keep', 'web')).toBe('keep');
    expect(effectiveMode('plain', 'word')).toBe('plain');
  });

  it('site web : structure et sémantique conservées, apparence normalisée', async () => {
    const ed = await paste(
      '<h2 style="color:red;font-family:Comic Sans MS">Titre</h2><p style="text-align:center;line-height:3">Un <strong>gras</strong>, <em>italique</em>, <a href="https://example.com">lien</a> ' +
        '<span style="color:#00f;font-size:30px;background-color:yellow">stylé</span></p>' +
        '<ul><li>un</li><li>deux</li></ul>',
    );
    const html = ed.getHTML();
    expect(html).toContain('<h2');
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('<em>italique</em>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<li>');
    expect(html).not.toMatch(
      /data-doc-color|data-doc-size|data-doc-font|data-color|text-align|line-height|<mark/,
    );
    expect(ed.getText()).toContain('stylé');
  });

  it('Word et Google Docs : mise en forme compatible conservée', async () => {
    const word = await paste(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class=MsoNormal style="mso-margin-top-alt:auto;color:#ff0000;font-size:12pt">Rouge<o:p></o:p></p></body></html>',
    );
    expect(word.getHTML()).toContain('data-doc-color="#ff0000"');
    expect(word.getHTML()).toContain('data-doc-size="16"');
    expect(word.getHTML()).not.toMatch(/mso|Mso|o:p/);
    const docs = await paste(
      '<b style="font-weight:normal;" id="docs-internal-guid-abc"><p>Normal <span style="font-weight:700">gras</span></p></b>',
    );
    const h = docs.getHTML();
    expect(h).toContain('<strong>gras</strong>');
    expect(h).not.toMatch(/<strong>Normal/); // le conteneur de Docs n'est pas du gras
  });

  it('Word : paragraphes de liste -> vraies listes imbriquées', async () => {
    const ed = await paste(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>' +
        '<p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span></span><![endif]>Un</p>' +
        '<p class=MsoListParagraphCxSpMiddle style="mso-list:l0 level2 lfo1"><span style="mso-list:Ignore">o<span>&nbsp;&nbsp;</span></span>Sous-élément</p>' +
        '<p class=MsoListParagraphCxSpLast style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">·</span>Deux</p>' +
        '<p class=MsoNormal>Fin</p></body></html>',
    );
    const html = ed.getHTML();
    expect(html).toMatch(
      /<ul><li><p>Un<\/p><ul><li><p>Sous-élément<\/p><\/li><\/ul><\/li><li><p>Deux<\/p><\/li><\/ul>/,
    );
    expect(html).toContain('Fin');
    expect(html).not.toMatch(/·|•/);
  });

  it('mode « compatible » explicite retire aussi la mise en forme venue de Word ; « keep » garde celle du web', async () => {
    const styled = '<p style="color:#ff0000">r</p>';
    expect((await paste(styled, 'compatible')).getHTML()).not.toContain('data-doc-color');
    expect((await paste(styled, 'keep')).getHTML()).toContain('data-doc-color="#ff0000"');
  });

  it('HTML malveillant : rien d’actif ne survit', async () => {
    const ed = await paste(
      '<p onclick="x()">a<script>alert(1)</script><iframe src="https://evil"></iframe><object data="x"></object>' +
        '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">lien</a><a href="data:text/html,x">d</a>' +
        '<svg onload="alert(1)"><script>1</script></svg><style>body{display:none}</style>' +
        '<form action="https://evil"><input name="p"></form><span style="display:none">caché</span>b</p>',
    );
    const html = ed.getHTML();
    expect(html).not.toMatch(
      /script|onclick|onerror|onload|iframe|object|<svg|<style|<form|<input|javascript:|data:text|display|evil/i,
    );
    expect(html).not.toContain('caché');
    expect(ed.getText()).toContain('a');
    expect(ed.getText()).toContain('b');
    expect(ed.getText()).toContain('lien');
  });

  it('tableaux collés : conservés, fonds de cellule retirés pour le web', async () => {
    const ed = await paste(
      '<table><tr><th style="background-color:#ff0">A</th><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
    );
    const html = ed.getHTML();
    expect((html.match(/<tr/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-bg');
  });

  it('texte brut : paragraphes, sauts de ligne, jamais interprété comme du HTML', async () => {
    const { pastePlainText } = await import('./SmartPaste');
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.selectAll();
    expect(pastePlainText(ed, 'un\ndeux\n\ntrois <b>pas gras</b> <script>1</script>')).toBe(true);
    const html = ed.getHTML();
    expect(html).toContain('<br');
    expect((html.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toMatch(/<b>|<script>/);
    expect(ed.getText()).toContain('<b>pas gras</b>');
    expect(pastePlainText(ed, '   \n ')).toBe(false);
  });
});

describe('liens', () => {
  it('seuls les liens autorisés sont acceptés dans le document (saisie, chargement, collage)', () => {
    const { ed } = make(undefined, '<p>t</p>');
    ed.commands.setContent(
      '<p><a href="https://ok.example">a</a> <a href="javascript:alert(1)">b</a> <a href="data:text/html,x">c</a> ' +
        '<a href="mailto:ada@example.com">d</a> <a href="slate://page/0192f0a0-0000-7000-8000-000000000001">e</a> <a href="file:///etc">f</a></p>',
    );
    const html = ed.getHTML();
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('href="mailto:ada@example.com"');
    expect(html).toContain('href="slate://page/0192f0a0-0000-7000-8000-000000000001"');
    expect(html).not.toMatch(/javascript:|data:text|file:/);
    ed.commands.selectAll();
    expect(ed.commands.setLink({ href: 'javascript:alert(1)' })).toBe(false);
    expect(ed.commands.setLink({ href: 'https://autre.example' })).toBe(true);
  });

  it('les liens internes alimentent les rétroliens', async () => {
    const { extractLinkTargets } = await import('./content');
    const { ed } = make(undefined, '<p>t</p>');
    ed.commands.setContent(
      '<p><a href="slate://page/0192f0a0-0000-7000-8000-000000000001">p</a> <a href="https://x.example">x</a></p>',
    );
    expect(extractLinkTargets(ed.getJSON() as never)).toEqual([
      '0192f0a0-0000-7000-8000-000000000001',
    ]);
  });
});

describe('listes et paragraphes', () => {
  it('styles de liste validés : puces et numérotations, conservés après réouverture', () => {
    const { ed, ydoc } = make(undefined, '<ul><li><p>a</p></li></ul>');
    ed.commands.setTextSelection(3);
    expect(ed.commands.setListStyle('square')).toBe(true);
    expect(ed.getHTML()).toContain('data-list-style="square"');
    expect(ed.commands.setListStyle('lower-roman')).toBe(false); // style de numérotation sur une liste à puces
    expect(ed.commands.setListStyle('javascript:1')).toBe(false);
    expect(ed.getHTML()).toContain('data-list-style="square"');
    ed.commands.toggleOrderedList();
    for (const style of ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman']) {
      expect(ed.commands.setListStyle(style), style).toBe(true);
      expect(ed.getHTML()).toContain(`data-list-style="${style}"`);
    }
    expect(ed.commands.setListStyle('disc')).toBe(false);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(make(reopened).ed.getHTML()).toBe(ed.getHTML());
  });

  it('un style de liste venu d’un HTML étranger est ignoré s’il n’est pas dans la liste blanche', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      '<ul data-list-style="javascript:alert(1)" style="list-style-image:url(x)"><li><p>a</p></li></ul><ol data-list-style="lower-alpha"><li><p>b</p></li></ol>',
    );
    const html = ed.getHTML();
    expect(html).not.toMatch(/javascript|list-style-image|url\(/);
    expect(html).toContain('data-list-style="lower-alpha"');
  });

  it('retrait des paragraphes : monte et descend, borné, plusieurs blocs, titres', () => {
    const { ed } = make(undefined, '<h2>t</h2><p>un</p><p>deux</p>');
    ed.commands.selectAll();
    ed.commands.increaseIndent();
    ed.commands.increaseIndent();
    expect((ed.getHTML().match(/data-indent="2"/g) ?? []).length).toBe(3);
    expect(ed.getHTML()).toContain('margin-left: 3rem');
    for (let i = 0; i < 20; i++) ed.commands.increaseIndent();
    expect(ed.getHTML()).toContain('data-indent="8"');
    expect(ed.getHTML()).not.toContain('data-indent="9"');
    for (let i = 0; i < 20; i++) ed.commands.decreaseIndent();
    expect(ed.getHTML()).not.toContain('data-indent');
    expect(ed.commands.decreaseIndent()).toBe(false); // déjà à zéro : rien à faire
    ed.commands.increaseRightIndent();
    expect(ed.getHTML()).toContain('margin-right: 1.5rem');
  });

  it('dans une liste, le retrait agit sur l’élément de liste', () => {
    const { ed } = make(undefined, '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    let b = -1;
    ed.state.doc.descendants((n, p) => void (n.isText && n.text === 'b' && (b = p)));
    ed.commands.setTextSelection(b + 1); // dans « b »
    expect(ed.commands.increaseIndent()).toBe(true);
    expect(ed.getHTML()).toMatch(/<ul><li><p>a<\/p><ul><li><p>b<\/p><\/li><\/ul><\/li><\/ul>/);
    expect(ed.getHTML()).not.toContain('data-indent');
    ed.commands.decreaseIndent();
    expect(ed.getHTML()).toMatch(/<ul><li><p>a<\/p><\/li><li><p>b<\/p><\/li><\/ul>/);
  });

  it('espacement avant et après : valeurs prédéfinies seulement, réinitialisation', () => {
    const { ed } = make(undefined, '<p>a</p>');
    ed.commands.selectAll();
    expect(ed.commands.setParagraphSpacing({ before: 12, after: 24 })).toBe(true);
    expect(ed.getHTML()).toContain('margin-top: 12px');
    expect(ed.getHTML()).toContain('margin-bottom: 24px');
    expect(ed.commands.setParagraphSpacing({ before: 13 })).toBe(false);
    expect(ed.commands.setParagraphSpacing({ after: 9999 })).toBe(false);
    expect(ed.getHTML()).toContain('margin-top: 12px');
    ed.commands.setParagraphSpacing({ before: null });
    expect(ed.getHTML()).not.toContain('margin-top');
    ed.commands.setLineHeight('1.5');
    ed.commands.increaseIndent();
    ed.commands.resetParagraphFormat();
    expect(ed.getHTML()).toBe('<p>a</p>');
  });

  it('un style de marge collé n’est pas repris (seules les valeurs validées le sont)', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      '<p style="margin-left:9999px;margin-top:-500px" data-indent="99" data-space-before="1">a</p>',
    );
    const html = ed.getHTML();
    expect(html).not.toMatch(/9999|-500|data-indent|data-space-before/);
  });

  it('retraits et espacements survivent à la réouverture', () => {
    const { ed, ydoc } = make(undefined, '<p>a</p>');
    ed.commands.selectAll();
    ed.commands.increaseIndent();
    ed.commands.setParagraphSpacing({ before: 8, after: 16 });
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(ydoc));
    expect(make(reopened).ed.getHTML()).toBe(ed.getHTML());
  });

  it('liste de tâches : progression calculée, mise à jour à chaque case, activable', () => {
    const { ed } = make(undefined, '<p>x</p>');
    ed.commands.setContent(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>a</p></li><li data-type="taskItem" data-checked="false"><p>b</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>c</p></li></ul></li></ul>',
    );
    const bar = () => ed.view.dom.querySelector('.task-progress');
    expect(bar()).toBeNull(); // désactivée par défaut
    ed.commands.setTextSelection(3);
    expect(ed.commands.toggleTaskProgress()).toBe(true);
    expect(bar()?.getAttribute('role')).toBe('progressbar');
    expect(bar()?.getAttribute('aria-valuenow')).toBe('2');
    expect(bar()?.getAttribute('aria-valuemax')).toBe('3');
    expect(bar()?.textContent).toContain('2/3');
    // cocher « b » met la barre à jour
    let pos = -1;
    ed.state.doc.descendants(
      (n, p) => void (n.type.name === 'taskItem' && n.textContent.startsWith('b') && (pos = p)),
    );
    ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { checked: true }));
    expect(bar()?.getAttribute('aria-valuenow')).toBe('3');
    expect(ed.getHTML()).toContain('data-progress="true"');
    ed.commands.toggleTaskProgress();
    expect(bar()).toBeNull();
    expect(ed.getHTML()).not.toContain('data-progress');
  });

  it('déplace un élément de liste vers le haut ou le bas, sans sortir de sa liste', () => {
    const { ed } = make(
      undefined,
      '<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul><p>fin</p>',
    );
    const text = () => [...ed.view.dom.querySelectorAll('li')].map((l) => l.textContent).join(',');
    ed.commands.setTextSelection(7); // dans « b »
    expect(ed.commands.moveListItem(-1)).toBe(true);
    expect(text()).toBe('b,a,c');
    expect(ed.state.selection.$from.parent.textContent).toBe('b'); // le curseur suit l'élément
    expect(ed.commands.moveListItem(-1)).toBe(true); // déjà en tête : rien ne bouge
    expect(text()).toBe('b,a,c');
    ed.commands.moveListItem(1);
    ed.commands.moveListItem(1);
    expect(text()).toBe('a,c,b');
    expect(ed.commands.moveListItem(1)).toBe(true);
    expect(text()).toBe('a,c,b');
    ed.commands.setTextSelection(ed.state.doc.content.size - 2); // hors liste
    expect(ed.commands.moveListItem(1)).toBe(false);
  });

  it('listes de tâches : cases, sous-tâches et sortie de liste par Entrée deux fois', () => {
    const { ed } = make(
      undefined,
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>a</p></li></ul>',
    );
    let a = -1;
    ed.state.doc.descendants((n, p) => void (n.isText && n.text === 'a' && (a = p)));
    ed.commands.setTextSelection(a + 1);
    expect(ed.isActive('taskItem')).toBe(true);
    ed.commands.splitListItem('taskItem'); // Entrée : nouvel élément
    expect((ed.getHTML().match(/data-type="taskItem"/g) ?? []).length).toBe(2);
    // Entrée sur un élément vide : la touche enchaîne splitListItem puis liftEmptyBlock (ProseMirror) -> sortie de la liste
    ed.commands.first(({ commands }) => [
      () => commands.splitListItem('taskItem'),
      () => commands.liftEmptyBlock(),
    ]);
    expect(ed.isActive('taskItem')).toBe(false);
    expect((ed.getHTML().match(/data-type="taskItem"/g) ?? []).length).toBe(1);
  });
});
