import { describe, expect, it } from 'vitest';
import { SlateError, toSlateError } from './errors';

describe('toSlateError', () => {
  it('reconnaît une erreur structurée du cœur Rust', () => {
    const e = toSlateError({
      code: 'db.newer_than_app',
      messageKey: 'errors.db.newer',
      retryable: false,
    });
    expect(e).toBeInstanceOf(SlateError);
    expect(e.code).toBe('db.newer_than_app');
    expect(e.retryable).toBe(false);
  });
  it('enveloppe les erreurs inconnues sans les perdre', () => {
    expect(toSlateError('boom').detail).toBe('boom');
    expect(toSlateError(new Error('x')).code).toBe('unknown');
    expect(toSlateError(42).code).toBe('unknown');
  });
});
