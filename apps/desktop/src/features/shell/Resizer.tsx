import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

const MIN = 200;
const MAX = 420;
const clamp = (n: number) => Math.min(MAX, Math.max(MIN, Math.round(n)));

/** Poignée de redimensionnement de la barre latérale (souris + clavier). */
export function Resizer({
  width,
  onPreview,
  onCommit,
}: {
  width: number;
  onPreview(w: number): void;
  onCommit(w: number): void;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: width, last: width };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clamp(d.startW + e.clientX - d.startX);
    onPreview(d.last);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.last !== d.startW) onCommit(d.last);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') onCommit(clamp(width - step));
    else if (e.key === 'ArrowRight') onCommit(clamp(width + step));
    else return;
    e.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.resizeSidebar')}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none"
    >
      <div className="mx-auto h-full w-px bg-line transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  );
}
