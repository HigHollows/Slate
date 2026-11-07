/**
 * Nettoyage du HTML collé (Word, Google Docs, sites web) AVANT l'analyse par le schéma de l'éditeur.
 * Le schéma reste la dernière barrière (il ne conserve que les nœuds et marques connus, avec des valeurs validées) ;
 * ce nettoyage retire le bruit propre aux sources et évite des erreurs d'interprétation (ex. le conteneur « gras »
 * de Google Docs, les « listes » de Word faites de paragraphes).
 */

export type PasteSource = 'word' | 'docs' | 'slate' | 'web';
export type PasteMode = 'auto' | 'keep' | 'compatible' | 'plain';

export function detectSource(html: string): PasteSource {
  if (/data-pm-slice=/.test(html)) return 'slate';
  if (/id=["']?docs-internal-guid/i.test(html)) return 'docs';
  if (/urn:schemas-microsoft-com:office|class=["']?Mso|<o:p>|ProgId[^>]*Word/i.test(html))
    return 'word';
  return 'web';
}

/** La mise en forme d'origine est conservée pour Word, Google Docs et Slate ; le web est normalisé selon le design de Slate. */
export function effectiveMode(
  mode: PasteMode,
  source: PasteSource,
): 'keep' | 'compatible' | 'plain' {
  if (mode === 'keep' || mode === 'compatible' || mode === 'plain') return mode;
  return source === 'web' ? 'compatible' : 'keep';
}

const DROP =
  'script,style,meta,link,title,head,iframe,object,embed,form,input,button,select,textarea,noscript,template,svg,canvas,audio,video,base';

function stripMso(style: string): string {
  return style
    .split(';')
    .filter(
      (d) => d.trim() !== '' && !/^\s*(mso-|tab-stops|page|margin-?(left|right)?:\s*0)/i.test(d),
    )
    .join(';');
}

/** Paragraphes de liste Word (`mso-list`) -> vraies listes imbriquées. */
function convertWordLists(doc: Document): void {
  const paras = [
    ...doc.body.querySelectorAll<HTMLElement>(
      'p[style*="mso-list"], p.MsoListParagraph, p.MsoListParagraphCxSpFirst, p.MsoListParagraphCxSpMiddle, p.MsoListParagraphCxSpLast',
    ),
  ];
  const done = new Set<HTMLElement>();
  for (const p of paras) {
    if (done.has(p)) continue;
    const run: HTMLElement[] = [];
    for (
      let n: Element | null = p;
      n &&
      n instanceof HTMLElement &&
      n.tagName === 'P' &&
      (n.matches('p[style*="mso-list"]') || /MsoListParagraph/.test(n.className));
      n = n.nextElementSibling
    )
      run.push(n);
    run.forEach((r) => done.add(r));
    const root = doc.createElement('ul');
    const stack: { level: number; list: HTMLElement; ordered: boolean }[] = [
      { level: 1, list: root, ordered: false },
    ];
    let first = true;
    for (const para of run) {
      const level = Number(/level(\d+)/.exec(para.getAttribute('style') ?? '')?.[1] ?? 1);
      // Le marqueur (puce, « 1. », « a) ») est dans un span `mso-list:Ignore` ou au début du texte.
      para
        .querySelectorAll('span[style*="mso-list:Ignore"], span[style*="mso-list: Ignore"]')
        .forEach((s) => s.remove());
      const lead = /^\s*(?:[•·o§▪–-]|\d+[.)]|[a-zA-Z][.)])\s+/.exec(para.textContent ?? '');
      const ordered = lead ? /^\s*(\d+|[a-zA-Z])[.)]/.test(lead[0]) : false;
      if (lead && para.firstChild?.nodeType === Node.TEXT_NODE)
        para.firstChild.textContent = (para.firstChild.textContent ?? '').replace(lead[0], '');
      while (stack.length > 1 && stack[stack.length - 1]!.level > level) stack.pop();
      if (first) {
        if (ordered) {
          const ol = doc.createElement('ol');
          stack[0] = { level, list: ol, ordered: true };
        } else stack[0] = { level, list: root, ordered: false };
        first = false;
      } else if (level > stack[stack.length - 1]!.level) {
        const sub = doc.createElement(ordered ? 'ol' : 'ul');
        const parentLi = stack[stack.length - 1]!.list.lastElementChild;
        (parentLi ?? stack[stack.length - 1]!.list).append(sub);
        stack.push({ level, list: sub, ordered });
      }
      const li = doc.createElement('li');
      li.innerHTML = para.innerHTML;
      stack[stack.length - 1]!.list.append(li);
    }
    p.before(stack[0]!.list);
    run.forEach((r) => r.remove());
  }
}

/** Couleur, taille et police posées sur un bloc (`<p style="color:red">`) : l'éditeur les porte sur le texte, on les descend dans un `span`. */
function pushDownBlockStyles(doc: Document): void {
  doc.body
    .querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,td,th,div,blockquote')
    .forEach((el) => {
      const { color, fontSize, fontFamily } = el.style;
      if ((!color && !fontSize && !fontFamily) || !el.firstChild) return;
      // N'enveloppe que le contenu en ligne (un bloc contenant d'autres blocs est laissé à ses enfants).
      if (
        [...el.children].some((c) =>
          /^(P|H[1-6]|UL|OL|LI|TABLE|DIV|BLOCKQUOTE|PRE)$/.test(c.tagName),
        )
      )
        return;
      const span = doc.createElement('span');
      const decl = [
        color && `color:${color}`,
        fontSize && `font-size:${fontSize}`,
        fontFamily && `font-family:${fontFamily}`,
      ].filter(Boolean);
      span.setAttribute('style', decl.join(';'));
      span.append(...el.childNodes);
      el.append(span);
      el.style.removeProperty('color');
      el.style.removeProperty('font-size');
      el.style.removeProperty('font-family');
    });
}

export function cleanPastedHTML(html: string): { html: string; source: PasteSource } {
  const source = detectSource(html);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll(DROP).forEach((e) => e.remove());
  // Commentaires conditionnels de Word et autres commentaires
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  // Éléments à espace de noms (o:p, w:…, v:…, st1:…) : on garde leur contenu
  doc.body.querySelectorAll('*').forEach((el) => {
    if (el.tagName.includes(':')) el.replaceWith(...el.childNodes);
  });
  // Conteneur « gras » de Google Docs : <b id="docs-internal-guid-…" style="font-weight:normal">
  doc.body
    .querySelectorAll('b[id^="docs-internal-guid"]')
    .forEach((el) => el.replaceWith(...el.childNodes));
  if (source === 'word') convertWordLists(doc);
  pushDownBlockStyles(doc);
  doc.body.querySelectorAll<HTMLElement>('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (
        n.startsWith('on') ||
        n === 'class' ||
        n === 'id' ||
        n === 'lang' ||
        n.startsWith('xml:') ||
        n === 'face'
      )
        el.removeAttribute(a.name);
      else if (n === 'style') {
        const s = stripMso(a.value);
        if (s) el.setAttribute('style', s);
        else el.removeAttribute('style');
      }
    }
    if (el.style?.display === 'none' || el.style?.visibility === 'hidden') el.remove();
  });
  // Spans vides ou sans effet
  doc.body.querySelectorAll('span').forEach((el) => {
    if (!el.attributes.length) el.replaceWith(...el.childNodes);
  });
  return { html: doc.body.innerHTML, source };
}
