import { describe, expect, it } from 'vitest';
import { readConfig } from './env';

describe('readConfig', () => {
  it('démarre en mode invité sans variables', () => {
    expect(readConfig({}).cloudEnabled).toBe(false);
  });
  it('refuse une URL invalide ou une clé manquante', () => {
    expect(
      readConfig({ VITE_SUPABASE_URL: 'pas une url', VITE_SUPABASE_ANON_KEY: 'k' }).cloudEnabled,
    ).toBe(false);
    expect(
      readConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: ' ' })
        .cloudEnabled,
    ).toBe(false);
  });
  it('active le cloud avec une configuration complète', () => {
    const c = readConfig({
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'k',
    });
    expect(c.cloudEnabled).toBe(true);
    expect(c.supabaseUrl).toBe('https://x.supabase.co');
  });
});
