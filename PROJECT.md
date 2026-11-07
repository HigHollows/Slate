# Slate — Vue d'ensemble du projet

> Statut : **Phase 0 (analyse et préparation) terminée — aucun code applicatif écrit.**
> Dernière mise à jour : 2026-11-06.

## 1. Vision

Slate est une application desktop (Windows + macOS) de productivité et de gestion des connaissances :
pages, bases de données, tâches, calendrier, objectifs/habitudes, tableaux de bord, automatisations,
fichiers, recherche, collaboration. Local-first, synchronisée via Supabase, utilisable hors ligne et sans compte.

Cinq principes : simplicité, puissance, fluidité, liberté, fiabilité. **La fiabilité des données prime sur tout.**

## 2. Environnement constaté (poste de développement)

| Élément | État | Remarque |
|---|---|---|
| macOS | 13.7.8, **x86_64 (Intel)** | Cible de build native Intel ; Apple Silicon = cross-compilation (`aarch64-apple-darwin` non installé). |
| Node | 24.20.0 | OK. |
| pnpm | 11.24.0 | Gestionnaire de paquets retenu. |
| Rust / Cargo | 1.99.1 (stable) | OK. Cible `x86_64-pc-windows-msvc` installée. |
| Tauri CLI | **absente** | Sera ajoutée en devDependency (`@tauri-apps/cli`), pas globalement. |
| Xcode complet | **absent** (seulement Command Line Tools) | Suffisant pour Tauri desktop macOS ; pas de iOS. |
| SQLite CLI | 3.39.5 | Outil de debug seulement ; l'app embarque SQLite via Rust. |
| Docker | 26.1.1 | Permet un Supabase local (`supabase start`) pour tester RLS/sync. |
| Supabase CLI | **absente** | À installer (`brew`/`npx supabase`) en Phase 7. |
| Supabase MCP | **disponible** dans l'environnement Claude Code | Outil de **développement uniquement** (migrations, inspection). |
| Windows | **aucune machine** | Les tests Windows se feront via CI GitHub Actions (runner `windows-latest`). Voir risque R9. |
| Dépôt | `~/Projects/slate`, vide, `git init` fait | Aucun fichier préexistant à préserver. |

Projet voisin existant (non lié, non modifié) : `~/Projects/assistant` (app Tauri « Visme »).
Il peut servir de référence de configuration (CI de release Tauri), **sans réutilisation de code non revue**.

## 3. Périmètre et non-périmètre

Dans le périmètre : tout ce qui est décrit dans le cahier des charges, découpé en 12 phases (voir `ROADMAP.md`).

Hors périmètre initial : Linux (prévu architecturalement, pas livré), mobile, IA (facultative, après les phases essentielles),
fournisseur de recherche sémantique.

## 4. Icônes — Papicons (contrainte imposée)

Source officielle : <https://icons.papillon.bzh/> → dépôt `PapillonApp/Papicons`.

Constats vérifiés :
- Licence **MIT** (© 2025 Association Papillon) — usage commercial et redistribution autorisés, à condition de conserver la notice (`THIRD_PARTY_LICENSES.md`).
- Catalogue : **113 fichiers** dans `icons/` (≈110 icônes SVG utilisables).
- Le paquet npm `@getpapillon/papicons` (v0.2.3) cible **React et React Native** et dépend de `react-native-svg` → **inadapté** à une app web/Tauri (poids, dépendance inutile).
- **Décision** (cf. DECISIONS D-011) : ne pas installer le paquet npm ; **vendre les SVG** du dépôt officiel (MIT) dans `packages/icons/`, générés en composants React par un script reproductible, avec notice de licence.
- Le catalogue est **limité** : pas d'icône pour tableau, base de données, glisser-déposer, italique, citation, case à cocher, annuler/rétablir, image/vidéo, etc.
  Règle du cahier des charges : *pas d'autre bibliothèque ; pas d'emoji* → solution typographique ou élément graphique minimal (ex. « H1 », « B/I » typographiques, formes SVG géométriques simples dessinées maison dans le même style). Inventaire des manques dans `DESIGN_ICONS.md` (créé en Phase 2).

## 5. Index de la documentation

| Fichier | Contenu |
|---|---|
| `PROJECT.md` | Ce fichier. |
| `ARCHITECTURE.md` | Architecture, modules, flux, sync, collaboration. |
| `ROADMAP.md` | Phases, critères d'acceptation, risques planifiés. |
| `DATA_MODEL.md` | Modèle de données SQLite/Postgres initial. |
| `SECURITY.md` | Modèle de menaces, RLS, PIN, secrets. |
| `TESTING.md` | Stratégie de tests. |
| `DECISIONS.md` | Journal des décisions (ADR légers). |

## 6. Conventions de code

- TypeScript `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Pas de `any` sans commentaire justifié.
- ESLint (règles d'import : **interdiction des imports croisés entre features hors `index.ts` public**, détection de cycles) + Prettier.
- Rust : `clippy -D warnings`, `rustfmt`. `unsafe` interdit sans revue.
- Nommage : fichiers `kebab-case`, composants `PascalCase`, types sans préfixe `I`.
- Commits : Conventional Commits. Une phase = une branche = une PR avec rapport de fin de phase.
- Aucune chaîne UI en dur : tout passe par i18n (`t('clé')`) ; lint dédié.
- Aucune clé secrète dans le dépôt ; `.env.example` seulement ; `gitleaks` en CI.
- Taille : fichier > 400 lignes = signal de refactor ; composant > 250 lignes idem.
- Dates stockées en UTC ISO-8601 ; identifiants = UUID v7 générés côté client.
