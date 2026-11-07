import { useEffect } from 'react';
import { useSecurity, useSecurityStore } from './context';

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'] as const;

/** Verrouille après `idleMinutes` sans activité (si un PIN est actif). */
export function useIdleLock(): void {
  const store = useSecurityStore();
  const minutes = useSecurity((s) => (s.lock?.enabled && !s.lock.locked ? s.lock.idleMinutes : 0));
  useEffect(() => {
    if (minutes <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void store.getState().lockNow(), minutes * 60_000);
    };
    arm();
    for (const e of EVENTS) window.addEventListener(e, arm, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, arm);
    };
  }, [minutes, store]);
}
