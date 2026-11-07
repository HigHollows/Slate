// Point d'entrée Deno : toute la logique est dans handler.ts (testée). Aucune clé dans le dépôt : les secrets
// RESEND_API_KEY et MAIL_FROM se définissent côté Supabase (jamais ici). verify_jwt reste activé.
import { handle } from './handler.ts';

interface DenoRuntime {
  env: { get(name: string): string | undefined };
  serve(h: (req: Request) => Response | Promise<Response>): void;
}
const deno = (globalThis as unknown as { Deno: DenoRuntime }).Deno;

deno.serve((req) => handle(req, { env: (n) => deno.env.get(n), fetch: (...a) => fetch(...a) }));
