/**
 * Enregistrement automatique fiable.
 *
 * Garanties :
 *  - le contenu est lu au MOMENT de l'enregistrement (toujours la dernière version) ;
 *  - aucune modification n'est jamais abandonnée : en cas d'échec, l'état reste « à enregistrer »,
 *    l'erreur est exposée et des nouvelles tentatives ont lieu (backoff) jusqu'au succès ;
 *  - une modification survenue PENDANT un enregistrement déclenche un nouvel enregistrement ;
 *  - `flush()` ne se résout que lorsque tout est écrit, et rejette si l'écriture échoue.
 */
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface SaveManagerOptions<P> {
  save(payload: P): Promise<void>;
  getPayload(): P;
  debounceMs?: number;
  retryDelaysMs?: number[];
  onStatus?(status: SaveStatus, error?: unknown): void;
  /** Appelé quand un gestionnaire libéré a fini d'écrire (il peut alors être désenregistré). */
  onReleased?(): void;
}

export class SaveManager<P> {
  status: SaveStatus = 'saved';
  lastError: unknown = undefined;
  private dirty = false;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private releasing = false;
  private disposed = false;
  private source: () => P;
  private readonly debounceMs: number;
  private readonly retry: number[];

  constructor(private readonly opts: SaveManagerOptions<P>) {
    this.source = opts.getPayload;
    this.debounceMs = opts.debounceMs ?? 500;
    this.retry = opts.retryDelaysMs ?? [1000, 3000, 10_000, 30_000];
  }

  hasPending(): boolean {
    return this.dirty || this.inflight !== null;
  }

  markDirty(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.inflight) return; // un nouvel enregistrement suivra la fin de celui en cours
    this.setStatus('dirty');
    this.schedule(this.debounceMs);
  }

  /** Remplace la source du contenu (ex. instantané figé avant la destruction de l'éditeur). */
  setSource(getPayload: () => P): void {
    this.source = getPayload;
  }

  /** Écrit tout ce qui est en attente. Rejette si l'écriture échoue (les données restent « à enregistrer »). */
  async flush(): Promise<void> {
    this.clearTimer();
    for (;;) {
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      if (!this.dirty) return;
      await this.run();
      if (this.status === 'error') throw this.lastError;
    }
  }

  retryNow(): Promise<void> {
    return this.flush();
  }

  /** Libère le gestionnaire dès que tout est écrit (les tentatives continuent en arrière-plan sinon). */
  release(): void {
    this.releasing = true;
    if (!this.hasPending()) this.finishRelease();
    else if (!this.timer && !this.inflight) void this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private finishRelease(): void {
    this.dispose();
    this.opts.onReleased?.();
  }

  private setStatus(s: SaveStatus, err?: unknown): void {
    this.status = s;
    this.lastError = err;
    this.opts.onStatus?.(s, err);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private run(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.clearTimer();
    this.dirty = false;
    this.setStatus('saving');
    const p = (async () => {
      try {
        await this.opts.save(this.source());
        this.attempts = 0;
        if (this.dirty) {
          this.setStatus('dirty');
          this.schedule(this.releasing ? 0 : this.debounceMs);
        } else {
          this.setStatus('saved');
          if (this.releasing) this.finishRelease();
        }
      } catch (e) {
        this.dirty = true; // jamais de perte silencieuse
        this.attempts += 1;
        this.setStatus('error', e);
        this.schedule(this.retry[Math.min(this.attempts - 1, this.retry.length - 1)] ?? 30_000);
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = p;
    return p;
  }
}

// ── Registre global : vider tout avant de fermer la fenêtre ──
const registry = new Set<SaveManager<never>>();
export function registerManager<P>(m: SaveManager<P>): () => void {
  const key = m as unknown as SaveManager<never>;
  registry.add(key);
  return () => registry.delete(key);
}
export function hasUnsavedChanges(): boolean {
  return [...registry].some((m) => m.hasPending());
}
/** Écrit tout ; rejette si au moins un enregistrement échoue. */
export async function flushAll(): Promise<void> {
  const results = await Promise.allSettled([...registry].map((m) => m.flush()));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed && failed.status === 'rejected') throw failed.reason;
}
