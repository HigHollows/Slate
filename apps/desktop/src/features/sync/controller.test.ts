import { describe, expect, it, vi } from 'vitest';
import { createSyncControl } from './controller';
import { createSyncStore } from './store';

const mk = (summary: { pulledNodes: number; pulledStruct: number; mergedDocs: number }) => {
  const onRemoteChange = vi.fn();
  const control = createSyncControl({
    client: {} as never,
    api: { syncEnable: vi.fn(), syncDisable: vi.fn(), syncStatus: vi.fn() } as never,
    engine: {
      runOnce: vi.fn(async () => ({ pushed: 0, compacted: 0, stalled: false, ...summary })),
      isRunning: () => false,
    },
    store: createSyncStore(),
    onRemoteChange,
    onError: vi.fn(),
  });
  return { control, onRemoteChange };
};

describe('contrôleur de synchronisation', () => {
  it.each([
    [{ pulledNodes: 0, pulledStruct: 0, mergedDocs: 0 }, 0],
    [{ pulledNodes: 1, pulledStruct: 0, mergedDocs: 0 }, 1],
    [{ pulledNodes: 0, pulledStruct: 2, mergedDocs: 0 }, 1],
    [{ pulledNodes: 0, pulledStruct: 0, mergedDocs: 3 }, 1],
  ])(
    'rafraîchit l’interface seulement si des données distantes sont arrivées (%o)',
    async (summary, calls) => {
      const { control, onRemoteChange } = mk(summary);
      await control.syncNow();
      expect(onRemoteChange).toHaveBeenCalledTimes(calls);
    },
  );
});
