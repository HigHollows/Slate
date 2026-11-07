# Rapport de Phase 1 — Fondations techniques

Date : 2026-11-06. Machine : macOS 13.7.8 Intel.

## Terminé (vérifié)
- Monorepo pnpm, Tauri 2, React 19, TypeScript strict (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vite 8, Tailwind 4.
- SQLite (rusqlite, WAL, clés étrangères) accédée uniquement depuis Rust ; migrations versionnées (checksum SHA-256, transaction par migration, refus si base plus récente ou migration modifiée, sauvegarde `VACUUM INTO` avant mise à niveau, échec de sauvegarde = migration bloquée).
- Erreur applicative unique sérialisée (`code`, `messageKey`, `retryable`) ; erreur de démarrage de base conservée et affichée par l'UI (pas de crash).
- Logs `tracing` (fichier rotatif quotidien + stderr), niveau via `SLATE_LOG`.
- Config d'environnement : sans `.env`, démarrage en mode invité (testé) ; `.env.example` fourni.
- i18n FR/EN (i18next) + script de parité des clés (`pnpm i18n:check`).
- Règle ESLint interdisant l'import interne d'une autre feature ; CSP stricte ; capability Tauri minimale (`core:default`, aucun accès fs/shell).
- CI GitHub Actions (macOS x64/arm64, Windows) — **écrite, jamais exécutée** (pas de dépôt distant).
- Icône provisoire dérivée du logo fourni.

## Tests exécutés
| Suite | Résultat |
|---|---|
| `cargo test` | 17 passés / 0 échec |
| `vitest` | 7 passés / 0 échec |
| `cargo clippy -D warnings`, `eslint`, `prettier`, `tsc`, `i18n:check` | 0 erreur |
| `pnpm build` (tauri build, release) | OK : `Slate.app` (8,2 Mo) et `Slate_0.1.0_x64.dmg` (3,8 Mo) |
| Lancement réel du binaire release | OK : base créée, migration 1 appliquée, `integrity_check = ok`, ligne `device` créée par l'appel IPC `system_info` de l'UI, logs écrits |

## Non vérifié / limites
- Aucune capture d'écran exploitable de la fenêtre : l'affichage de l'UI n'est pas vérifié visuellement (seulement via ses effets : IPC exécuté).
- Windows et Apple Silicon : non testés (CI écrite, non exécutée). Aucun test e2e encore (Phase 2+).
- Build non signé (Gatekeeper avertira). Pas de test de fermeture brutale pendant migration (à ajouter avec la sync).
- Logo : l'image reçue n'est pas un fichier ; `brand/slate-mark.svg` est une approximation à remplacer par le fichier source (SVG/PNG 1024 px) puis `pnpm --filter @slate/desktop exec tauri icon <fichier>`.
- Pas de commit Git créé.

## Décisions techniques
- D-004 tranchée provisoirement : types TS écrits à la main + **validation Zod à l'exécution** des réponses IPC ; génération depuis Rust reportée.
- Versions : ESLint 9 et TypeScript 5.9 (au lieu de ESLint 10 / TS 7) pour compatibilité avec typescript-eslint et les plugins ; à réévaluer.
- Correction en cours de phase : `.ok()` sur la lecture de `device` aurait masqué une erreur SQL et pu créer un 2ᵉ identifiant d'appareil → remplacé par `.optional()?`.

## Prochaine étape recommandée
Phase 2 (design system, Papicons, barre latérale, palette Cmd+K, paramètres), après fourniture du logo source.
