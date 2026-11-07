import { createStore, useStore } from 'zustand';
import type { SyncStatus } from '../../shared/ipc/client';

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'offline' | 'error' | 'auth';

export interface SyncUiState {
  phase: SyncPhase;
  status: SyncStatus | null;
  /** Dernière synchronisation complète ET confirmée (file vide, accusés reçus). */
  lastOkAt: string | null;
  error: string | null;
  set(p: Partial<Omit<SyncUiState, 'set'>>): void;
}

export const createSyncStore = () =>
  createStore<SyncUiState>((set) => ({
    phase: 'off',
    status: null,
    lastOkAt: null,
    error: null,
    set: (p) => set(p),
  }));
export type SyncStore = ReturnType<typeof createSyncStore>;
export const useSyncState = <T>(store: SyncStore, selector: (s: SyncUiState) => T): T =>
  useStore(store, selector);
