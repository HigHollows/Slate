import { createStore } from 'zustand';
import type { Ipc, LockState } from '../../shared/ipc/client';
import { toSlateError, type SlateError } from '../../shared/ipc/errors';

export type SecurityApi = Pick<
  Ipc,
  'pinStatus' | 'pinSet' | 'pinDisable' | 'pinVerify' | 'pinLock' | 'pinOptions'
>;

export interface SecurityState {
  status: 'loading' | 'ready' | 'error';
  lock: LockState | null;
  refresh(): Promise<void>;
  /** Retourne `null` si le PIN est accepté, sinon l'erreur (PIN incorrect, blocage…) pour l'afficher sur place. */
  unlock(pin: string): Promise<SlateError | null>;
  lockNow(): Promise<void>;
  setPin(pin: string, current: string | null): Promise<SlateError | null>;
  disablePin(pin: string): Promise<SlateError | null>;
  setOptions(pin: string, lockOnStart: boolean, idleMinutes: number): Promise<SlateError | null>;
}

/** Le PIN n'est jamais conservé dans l'état : il transite uniquement vers le cœur natif. */
export function createSecurityStore(api: SecurityApi, onError: (e: unknown) => void = () => {}) {
  return createStore<SecurityState>((set, get) => {
    const apply = async (call: () => Promise<LockState>): Promise<SlateError | null> => {
      try {
        set({ lock: await call(), status: 'ready' });
        return null;
      } catch (e) {
        const err = toSlateError(e);
        // Un refus attendu (PIN faux, blocage, verrou) se montre sur place ; le reste est signalé.
        if (!['pin.invalid', 'pin.locked', 'locked', 'ipc.invalid'].includes(err.code)) onError(e);
        if (err.code === 'locked') void get().refresh();
        else if (err.code.startsWith('pin.')) void get().refresh();
        return err;
      }
    };
    return {
      status: 'loading',
      lock: null,
      async refresh() {
        try {
          set({ lock: await api.pinStatus(), status: 'ready' });
        } catch (e) {
          set({ status: 'error' });
          onError(e);
        }
      },
      unlock: (pin) => apply(() => api.pinVerify(pin)),
      async lockNow() {
        await apply(() => api.pinLock());
      },
      setPin: (pin, current) => apply(() => api.pinSet(pin, current)),
      disablePin: (pin) => apply(() => api.pinDisable(pin)),
      setOptions: (pin, lockOnStart, idle) => apply(() => api.pinOptions(pin, lockOnStart, idle)),
    };
  });
}
export type SecurityStore = ReturnType<typeof createSecurityStore>;
