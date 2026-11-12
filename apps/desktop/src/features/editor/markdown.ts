/**
 * Export d'une page en Markdown (format GitHub) à partir de son JSON Tiptap. Fonction PURE : aucun accès réseau ni fichier ;
 * le texte est copié dans le presse-papiers par l'appelant. Ce qui n'a pas d'équivalent Markdown (couleurs, alignement, blocs
 * repliables, encadrés) est exporté en texte lisible, jamais perdu en silence : le contenu textuel est toujours conservé.
 */
interface N {
  type?: string;
  text?: string;
  content?: N[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const esc = (s: string): string => s.replace(/([\\`*_{}[\]<>#|])/g, '\\$1');
const safeHref = (h: unknown): string | null =>
  typeof h === 'string' && /^(https?:|mailto:|slate:|#|\/)/i.test(h)
    ? h.replace(/[()\s]/g, encodeURIComponent)
    : null;

function inline(nodes: N[] | undefined): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out += '  \n';
      continue;
    }
    if (n.type === 'image') {
      out += `![${esc(String(n.attrs?.alt ?? ''))}]()`;
      continue;
    }
    const raw = n.text ?? inline(n.content);
    const marks = new Set((n.marks ?? []).map((m) => m.type));
    // Les espaces de bord sortent des marques (sinon le Markdown ne s'interprète pas).
    const m = /^(\s*)(.*?)(\s*)$/s.exec(raw) ?? ['', '', raw, ''];
    let core = m[2] ?? '';
    if (core) {
      core = marks.has('code') ? '`' + core.replace(/`/g, "'") + '`' : esc(core);
      if (marks.has('bold')) core = `**${core}**`;
      if (marks.has('italic')) core = `*${core}*`;
      if (marks.has('strike')) core = `~~${core}~~`;
      const link = (n.marks ?? []).find((x) => x.type === 'link');
      const href = link ? safeHref(link.attrs?.href) : null;
      if (href) core = `[${core}](${href})`;
    }
    out += (m[1] ?? '') + core + (m[3] ?? '');
  }
  return out;
}

function blocks(nodes: N[] | undefined, indent = ''): string[] {
  const out: string[] = [];
  for (const n of nodes ?? []) out.push(...block(n, indent));
  return out;
}

const prefix = (lines: string, first: string, rest: string): string =>
  lines
    .split('\n')
    .map((l, i) => (i === 0 ? first : l === '' ? '' : rest) + l)
    .join('\n');

function list(n: N, indent: string): string[] {
  const ordered = n.type === 'orderedList';
  const start = Number(n.attrs?.start ?? 1) || 1;
  const items = (n.content ?? []).map((li, i) => {
    const kids = li.content ?? [];
    const head = kids[0]?.type === 'paragraph' ? inline(kids[0].content) : '';
    const rest = blocks(kids[0]?.type === 'paragraph' ? kids.slice(1) : kids, '').join('\n\n');
    const task = li.type === 'taskItem' ? (li.attrs?.checked ? '[x] ' : '[ ] ') : '';
    const mark = ordered ? `${start + i}. ` : '- ';
    const body = task + head + (rest ? '\n' + rest : '');
    return prefix(body, indent + mark, indent + ' '.repeat(mark.length));
  });
  return [items.join('\n')];
}

function table(n: N): string[] {
  const rows = (n.content ?? []).map((r) =>
    (r.content ?? []).map((c) =>
      inline((c.content ?? []).flatMap((p) => p.content ?? []))
        .replace(/(?<!\\)\|/g, '\\|')
        .replace(/\n/g, ' '),
    ),
  );
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [
    [
      pad(rows[0]!),
      `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
      ...rows.slice(1).map(pad),
    ].join('\n'),
  ];
}

function block(n: N, indent: string): string[] {
  switch (n.type) {
    case 'paragraph': {
      const t = inline(n.content);
      return t ? [indent + t] : [];
    }
    case 'heading': {
      const lvl = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1) || 1));
      return ['#'.repeat(lvl) + ' ' + inline(n.content)];
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return list(n, indent);
    case 'blockquote':
      return [prefix(blocks(n.content).join('\n\n'), '> ', '> ')];
    case 'codeBlock': {
      const code = (n.content ?? []).map((c) => c.text ?? '').join('');
      const lang =
        typeof n.attrs?.language === 'string' && /^[\w+#.-]{1,30}$/.test(n.attrs.language)
          ? n.attrs.language
          : '';
      const fence = code.includes('```') ? '~~~' : '```';
      return [`${fence}${lang}\n${code}\n${fence}`];
    }
    case 'horizontalRule':
      return ['---'];
    case 'table':
      return table(n);
    case 'image':
      return [`![${esc(String(n.attrs?.alt ?? ''))}]()`];
    case 'details':
    case 'callout':
    case 'detailsContent':
    case 'detailsSummary':
    default:
      // Bloc sans équivalent : son contenu est conservé tel quel.
      return n.content ? blocks(n.content, indent) : n.text ? [esc(n.text)] : [];
  }
}

export function pageToMarkdown(json: string | N, title?: string): string {
  let doc: N;
  try {
    doc = typeof json === 'string' ? (JSON.parse(json) as N) : json;
  } catch {
    return title ? `# ${esc(title)}\n` : '';
  }
  const parts = blocks(doc.content);
  if (title?.trim()) parts.unshift(`# ${esc(title.trim())}`);
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
