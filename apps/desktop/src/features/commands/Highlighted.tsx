import type { ReactNode } from 'react';

const START = String.fromCharCode(2);
const END = String.fromCharCode(3);

/** Affiche un extrait dont les correspondances sont encadrées par U+0002/U+0003 (jamais interprété comme HTML). */
export function Highlighted({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let buf = '';
  let on = false;
  const flush = (key: number) => {
    if (!buf) return;
    out.push(
      on ? (
        <strong key={key} className="font-semibold text-fg">
          {buf}
        </strong>
      ) : (
        <span key={key}>{buf}</span>
      ),
    );
    buf = '';
  };
  let i = 0;
  for (const ch of text) {
    if (ch === START || ch === END) {
      flush(i++);
      on = ch === START;
    } else buf += ch;
  }
  flush(i);
  return <>{out}</>;
}
