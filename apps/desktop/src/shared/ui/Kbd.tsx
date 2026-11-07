import { isMac } from './platform';

const SYMBOLS_MAC: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧', Ctrl: '⌃' };
const SYMBOLS_OTHER: Record<string, string> = {
  Mod: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Maj',
  Ctrl: 'Ctrl',
};

export function formatCombo(combo: string, mac = isMac()): string[] {
  const sym = mac ? SYMBOLS_MAC : SYMBOLS_OTHER;
  return combo.split('+').map((k) => sym[k] ?? (k.length === 1 ? k.toUpperCase() : k));
}

export function Kbd({ combo }: { combo: string }) {
  const keys = formatCombo(combo);
  return (
    <span className="inline-flex gap-0.5">
      <span className="sr-only">{keys.join(' ')}</span>
      {keys.map((k, i) => (
        <kbd
          key={i}
          aria-hidden="true"
          className="min-w-5 rounded border border-line bg-surface px-1 text-center font-sans text-[0.6875rem] text-muted"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
