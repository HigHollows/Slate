# Audit des fondations (Phase 1) — état réel du dépôt

Date : 2026-11-07. Cet audit confronte le prompt « Démarrage du développement » à l'état réel du dépôt. Les fondations ont été livrées en Phase 1 (`PHASE_1_REPORT.md`) puis éprouvées pendant les Phases 2 à 4 : elles n'ont **pas** été refaites.

## Critères de validation
| # | Critère | État | Preuve / limite |
|---|---|---|---|
| 1 | L'application démarre | ✅ | Binaire de production lancé : base créée, migrations appliquées, logs écrits ; utilisé manuellement (page créée puis mise à la corbeille). |
| 2 | Tauri 2 | ✅ | `tauri 2`, CLI 2.12.4, capacités minimales, CSP stricte. |
| 3 | React | ✅ | React 19.3, 169 tests d'interface. |
| 4 | TypeScript strict | ✅ | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnused*` ; aucune vérification désactivée. TS 5.9 (et non 7, voir D-004/Phase 1). |
| 5 | Tailwind | ✅ | Tailwind 4.3 + tokens CSS (`styles.css`). |
| 6 | SQLite | ✅ | rusqlite 0.32 (SQLite embarqué), WAL, `foreign_keys=ON`, `synchronous=FULL`, FTS5. |
| 7 | Migrations | ✅ | 3 migrations versionnées, checksum, transaction par migration, refus si base plus récente, sauvegarde pré-migration, support « clés étrangères désactivées » contrôlé (D-032). |
| 8 | Persistance | ✅ | Tests Rust qui rouvrent la base (y compris après abandon de connexion) ; base réelle de développement conservée entre lancements et migrée v1→v2. Un test de redémarrage **du processus Tauri** n'est pas automatisé. |
| 9 | Interface cohérente | ✅ (sur plan) | Shell, barre latérale, paramètres, palette, pages, bases. Le rendu des vues de base n'a pas été vérifié visuellement. |
| 10 | Thèmes | ✅ | Clair/sombre/système, accent, densité, taille, police : testés (état + application au document). |
| 11 | Traductions | ✅ | FR/EN, 430 clés, parité vérifiée par script en CI. |
| 12 | Tests pertinents | ✅ | Rust 95 · formules 38 · interface 169 · icônes 3 — tous exécutés et verts. |
| 13 | Linting | ✅ | ESLint + Prettier + clippy `-D warnings` + rustfmt : 0 erreur. |
| 14 | Build disponible | voir rapport | macOS Intel uniquement (voir ci-dessous). |
| 15 | Documentation | ✅ | 7 documents de Phase 0 + rapports de phases + décisions D-001…D-039. |

## Écarts avec le prompt (et décisions)
- **Arborescence** : le prompt cite `components/ services/ hooks/ types/ utils/ styles/ tests/`. Le dépôt utilise `app/`, `features/<module>/` (composants, logique, types et tests **colocalisés**), `shared/` (ui, ipc, i18n, config) et des packages (`icons`, `formula`). Décision maintenue : un dossier fourre-tout `components/` ou `utils/` regrouperait des responsabilités sans lien et casserait la règle « une feature n'importe une autre que par son `index.ts` » (appliquée par ESLint). La base de données vit côté Rust (`src-tauri/src/db`, `migrations/`), jamais dans le WebView (D-003, sécurité).
- **Dépendances** : `pnpm audit --prod` : aucune vulnérabilité connue ; `cargo audit` non installé (non vérifié).

## Non vérifiable dans cet environnement
- **Windows** : aucune machine ; la cible `x86_64-pc-windows-msvc` est installée mais le bundle Windows (MSI/NSIS) n'a **jamais été construit**. La CI GitHub (`.github/workflows/ci.yml`, matrice macOS x64 / macOS arm64 / Windows) est écrite mais **n'a jamais été exécutée** (aucun dépôt distant).
- **macOS Apple Silicon** : non construit ni testé (machine Intel).
- **Signature / notarisation** : absentes (builds non signés).

## Risque identifié pendant l'audit
Le dépôt Git ne contient **aucun commit** : tout le travail des Phases 0-4 n'est que dans le répertoire de travail. À corriger dès que vous l'autorisez.
