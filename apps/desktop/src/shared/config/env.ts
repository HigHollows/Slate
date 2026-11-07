export interface AppConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** Le cloud n'est disponible que si URL et clé publique sont toutes deux valides. */
  cloudEnabled: boolean;
}

function clean(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Lit la configuration. Une configuration absente ou invalide => mode invité, sans erreur. */
export function readConfig(env: Record<string, unknown> = import.meta.env): AppConfig {
  const url = clean(env['VITE_SUPABASE_URL']);
  const key = clean(env['VITE_SUPABASE_ANON_KEY']);
  const ok = url !== null && key !== null && isHttpUrl(url);
  return {
    supabaseUrl: ok ? url : null,
    supabaseAnonKey: ok ? key : null,
    cloudEnabled: ok,
  };
}
