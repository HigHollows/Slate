import { z } from 'zod';

/** Erreur sérialisée par le cœur Rust (cf. src-tauri/src/error.rs). */
export const appErrorSchema = z.object({
  code: z.string(),
  messageKey: z.string(),
  retryable: z.boolean(),
  detail: z.string().optional(),
  retryAfterMs: z.number().optional(),
  failedCount: z.number().optional(),
});
export type AppErrorPayload = z.infer<typeof appErrorSchema>;

export class SlateError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
    readonly retryable: boolean,
    readonly detail?: string,
    readonly retryAfterMs?: number,
    readonly failedCount?: number,
  ) {
    super(detail ?? code);
    this.name = 'SlateError';
  }
}

/** Normalise toute erreur d'IPC (jamais d'erreur avalée ni de `unknown` propagé). */
export function toSlateError(e: unknown): SlateError {
  const parsed = appErrorSchema.safeParse(e);
  if (parsed.success) {
    const p = parsed.data;
    return new SlateError(
      p.code,
      p.messageKey,
      p.retryable,
      p.detail,
      p.retryAfterMs,
      p.failedCount,
    );
  }
  if (e instanceof SlateError) return e;
  const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : undefined;
  return new SlateError('unknown', 'errors.unknown', false, detail);
}
