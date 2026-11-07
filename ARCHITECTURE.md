# Slate — Architecture

> Statut : proposition Phase 0. Les choix structurants sont consignés dans `DECISIONS.md` (références D-xxx).

## 1. Principe directeur : local-first

La **base SQLite locale est la source de vérité de l'interface**. L'UI ne lit et n'écrit jamais directement dans Supabase.
Le cloud est un *réplica de synchronisation et un point de rencontre pour la collaboration*, **pas une sauvegarde** (cf. § 8).

```
┌──────────────────────────── Tauri 2 app ─────────────────────────────┐
│  WebView (React + TS)                  │  Cœur Rust                  │
│  ┌──────────────────────────────┐      │  ┌────────────────────────┐ │
│  │ features/* (UI + hooks)      │◄────►│  │ commands (IPC typé)    │ │
│  │ editor (Tiptap/ProseMirror+Yjs)│ IPC │  │ db (rusqlite, migrations)│ │
│  │ state: TanStack Query+Zustand│      │  │ search (FTS5)          │ │
│  └──────────────────────────────┘      │  │ sync engine            │ │
│          │ supabase-js (auth, realtime)│  │ files / backups / pin  │ │
└──────────┼─────────────────────────────┴──┴────────────────────────┴─┘
           ▼
   Supabase : Auth · Postgres+RLS · Storage · Realtime (transport) · Edge Functions
```

## 2. Structure du dépôt (monorepo pnpm)

```
slate/
  apps/desktop/            # Tauri 2 + app React
    src/                   # frontend
      app/                 # bootstrap, routing, providers
      features/            # un dossier par module (voir § 3)
      shared/              # design system (ui/), i18n, hooks, utils
    src-tauri/             # Rust : commandes IPC, db, sync, fichiers, pin
      migrations/          # SQL SQLite versionné (NNNN_nom.sql)
  packages/
    schema/                # types + validation (Zod) partagés front/Edge Functions
    icons/                 # SVG Papicons vendus + composants générés
    formula/               # parseur/évaluateur de formules (pur, testé)
    sync-protocol/         # types d'opérations, HLC, règles de résolution (pur, testé)
  supabase/
    migrations/            # SQL Postgres versionné + RLS
    functions/             # Edge Functions (automatisations cloud, invitations…)
    tests/                 # tests pgTAP RLS
  docs/                    # guides utilisateur / maintenance
```

Les packages `schema`, `formula`, `sync-protocol` sont **purs** (sans I/O) : testables unitairement, réutilisables en Edge Functions.

## 3. Modules (features) et responsabilités

Chaque feature : `components/ · hooks/ · services/ · model/ (types) · validation/ · __tests__/ · index.ts` (API publique unique).

| Module | Responsabilité |
|---|---|
| `workspace` | Espaces, arborescence (dossiers/pages/raccourcis), favoris, récents, épingles, déplacement DnD. |
| `editor` | Schéma de blocs, menu `/`, mentions, liens internes, commentaires ancrés, historique. |
| `databases` | Propriétés (registre extensible), vues (table/kanban/calendrier/galerie/liste), filtres/tris/groupes, relations, formules. |
| `tasks` | Tâches = entrées d'une base système « Tâches » (cohérence garantie, cf. § 6). |
| `calendar` | Agrégation lecture/écriture des propriétés date, tâches, événements. |
| `goals` | Objectifs, habitudes, séries, statistiques. |
| `dashboards` | Grille de widgets (composants réels), configurations enregistrées. |
| `automations` | Moteur Quand→Si→Alors, historique, anti-boucle. |
| `files` | Bibliothèque, stockage local/cloud, aperçus, extraction PDF. |
| `search` | Index FTS5 local, filtres, aperçus. |
| `knowledge` | Liens bidirectionnels, backlinks, graphe (secondaire). |
| `templates` | Modèles imbriqués, import/export. |
| `collab` | Yjs, présence, curseurs, invitations, permissions. |
| `auth` | Supabase Auth, mode invité/connecté, migration invité→compte. |
| `sync` | Statut, file d'attente, résolution de conflits (UI). Moteur côté Rust. |
| `backup` | Sauvegardes, versions, corbeille, restauration, intégrité. |
| `security` | PIN, verrouillage, inactivité. |
| `settings` / `i18n` / `commands` | Préférences & profils, FR/EN, palette Ctrl/Cmd+K. |
| `notifications` | Rappels locaux (OS) + invitations/mentions (cloud). |
| `ai` (optionnel, tardif) | Interface fournisseur, consentement, quotas. Désactivé par défaut. |

Règles de dépendance (appliquées par ESLint `import/no-restricted-paths` + `dependency-cruiser` en CI) :
`shared` ← `features/*` ← `app`. Une feature n'importe une autre que via son `index.ts` ; pas de cycle.
Les features communiquent via des **événements du domaine** (bus typé) et des **ports** (interfaces) plutôt que par imports directs lorsque le couplage est inversé (ex. `automations` écoute `tasks`).

## 4. Persistance locale (SQLite)

- **Accès uniquement depuis Rust** (rusqlite, mode WAL, `foreign_keys=ON`, `synchronous=NORMAL`→`FULL` pour les écritures de sync). Le WebView n'a aucun accès SQL brut (surface d'attaque réduite, cf. SECURITY).
- Commandes IPC **typées et validées** (types générés depuis Rust via `specta`/`ts-rs`, ou schémas Zod partagés — choix confirmé en Phase 1, D-004).
- Migrations : fichiers `NNNN_nom.sql` embarqués, table `_migrations` (version, checksum, appliquée_le). Exécution en transaction, **sauvegarde automatique du fichier avant migration**, refus de démarrer si checksum divergent ou si la base est plus récente que l'app.
- Recherche : tables virtuelles **FTS5** (tokenizer `unicode61 remove_diacritics 2`, accents FR), alimentées par triggers/étape applicative transactionnelle.
- Événements de changement : Rust émet `data-changed {entity, ids}` → invalidation ciblée des requêtes TanStack Query (chaque vue d'une base voit immédiatement les modifications des autres).
- Chiffrement au repos : **non inclus en v1** (SQLCipher = coût build Windows/macOS non négligeable). Documenté comme limite dans SECURITY ; le PIN est un verrou d'interface, pas un chiffrement (D-009).

## 5. Contenu de page et éditeur

- Moteur : **Tiptap (MIT) sur ProseMirror**, extensions maison pour les blocs Slate (callout, bloc base de données, mention, etc.).
- **Stockage du contenu** : deux représentations dans une même transaction :
  1. `doc_state` : état **Yjs** (binaire) = source de vérité éditable/collaborative ;
  2. `content_json` : instantané ProseMirror JSON **dérivé** (indexation, export, rendu en lecture, migrations de schéma).
  Le JSON est indépendant du rendu (aucune HTML stockée).
- Versionnage du schéma d'éditeur (`schema_version`) + fonctions de migration de document testées.
- Sauvegarde automatique : debounce court (~300 ms) → IPC → transaction SQLite ; indicateur d'état explicite (enregistré / en cours / **échec avec retry et conservation en mémoire**). Un échec n'efface jamais le buffer. `beforeunload`/fermeture Tauri : flush bloquant.

## 6. Bases de données, tâches, calendrier : un seul modèle

- Une *base de données* = `databases` + `properties` (schéma) + `rows` (entrées) + `cells`/colonne JSON typée (voir DATA_MODEL).
- Les **tâches** sont des lignes d'une base système « Tâches » (propriétés typées standard : statut, priorité, échéance, assignés, parent, récurrence…). Kanban/liste/calendrier = *vues* de cette base ⇒ une tâche est un seul objet, cohérent partout.
- Le **calendrier** est une vue transversale qui lit les propriétés `date`/`datetime` des bases choisies ; déplacer un événement écrit la propriété source.
- **Propriétés = registre extensible** : chaque type déclare `{ validate, serialize, defaultValue, compare, filterOps, cellEditor, cellRenderer, syncStrategy }`.
- **Formules** : langage propre, **parseur + évaluateur AST sans `eval`/`Function`**, fonctions en liste blanche, limites de profondeur/temps/taille, détection de cycles de dépendances (`packages/formula`).
- Performance : virtualisation (TanStack Virtual), pagination par curseur côté Rust, tri/filtre exécutés en SQL (index + colonnes JSON extraites/générées) au-delà d'un seuil.

## 7. Recherche et connaissances

- Index FTS5 unifié (`search_index(kind, entity_id, space_id, title, body, updated_at)`), filtres par type/espace/date, `snippet()`/`highlight()` pour la mise en évidence. Fonctionne hors-ligne, sans IA.
- PDF : extraction du texte en **Rust** (crate d'extraction évaluée en Phase 9 ; fallback pdf.js dans le WebView) → table `file_text` indexée. Aperçu via pdf.js (Apache-2.0).
- Liens : table `links(source_type, source_id, target_type, target_id, kind)` reconstruite à chaque sauvegarde de page (mentions/liens internes) ⇒ backlinks par simple requête indexée.

## 8. Moteur de synchronisation (point le plus critique)

### 8.1 Choix d'architecture

Deux régimes distincts (D-005, D-006) :

1. **Documents (contenu de page)** → **CRDT Yjs**. Fusion automatique sans perte ; aucune règle LWW.
2. **Données structurées** (espaces, pages-méta, bases, propriétés, lignes, tâches, vues, préférences…) → **journal d'opérations + résolution par champ avec Hybrid Logical Clock (HLC)**, règles propres à chaque type.

### 8.2 Écriture locale

Toute mutation = **une transaction SQLite** qui (a) modifie les tables métier, (b) incrémente la version locale, (c) insère une ligne dans `oplog` (outbox) : `op_id` (UUID v7, clé d'idempotence), `entity`, `entity_id`, `kind` (`upsert_fields` | `delete` | `restore` | `move`), `fields` (patch), `hlc`, `base_version`, `device_id`, `status`. Atomique : pas d'écriture métier sans opération associée ⇒ reprise après crash garantie.

### 8.3 Push / pull

- **Push** : un worker Rust lit l'outbox par lots ordonnés, appelle une **fonction Postgres RPC `apply_ops(batch)`** (SECURITY INVOKER, donc soumise à RLS) qui : vérifie les permissions, déduplique par `op_id` (table `applied_ops`, PK = op_id ⇒ **idempotence**), applique la fusion par champ, renvoie le résultat par opération (`applied | merged | rejected(reason)`). Backoff exponentiel + jitter ; reprise après coupure.
- **Pull** : curseur serveur monotone par espace (`server_seq`, séquence/identity). Le client demande « tout ce qui a `server_seq > curseur` » (pagination), applique en transaction locale, avance le curseur **dans la même transaction**. Realtime (postgres_changes/broadcast) sert uniquement de **signal de réveil** ; l'exactitude repose sur le pull par curseur (jamais sur la livraison Realtime).
- **Suppressions** : *tombstones* (`deleted_at`, `deleted_by`) synchronisés ; purge définitive seulement après rétention et accusé de réception de tous les appareils (ou délai configuré).
- **Identifiants stables** : UUID v7 clients ⇒ création hors-ligne sans collision ; `device_id` persistant.

### 8.4 Stratégie de résolution par type (tableau normatif)

| Donnée | Stratégie |
|---|---|
| Contenu de page | CRDT Yjs (fusion). |
| Champ scalaire d'une ligne/entité (titre, statut, date…) | LWW **par champ** avec HLC (pas par objet entier ⇒ deux utilisateurs modifiant deux champs différents ne s'écrasent pas). Égalité HLC → départage déterministe par `device_id`. |
| Multi-sélection / assignés / tags | Fusion ensembliste (OR-Set : ajouts/retraits suivis par élément). |
| Ordre (blocs de sidebar, lignes, colonnes, kanban) | Indices **fractionnaires** (fractional indexing) ⇒ insertions concurrentes sans réécriture ; rééquilibrage périodique. |
| Déplacement dans l'arborescence | Opération `move` ; LWW sur `parent_id` + **détection de cycles** côté serveur (rejet/réparation déterministe). |
| Suppression vs modification concurrente | Suppression prime **mais restaurable** (corbeille) ; une modification postérieure à la suppression est conservée dans l'historique et signalée. |
| Schéma d'une base (propriétés) | LWW par propriété ; suppression de propriété = tombstone, données conservées. Changement de type = opération explicite versionnée (jamais silencieux). |
| Compteurs (ID auto) | Attribution serveur à la première sync ; ID local provisoire. |
| Préférences UI | LWW par clé, par appareil ou globale selon la préférence. |
| Fichiers | Contenu **immuable adressé par hash** (SHA-256) ⇒ pas de conflit sur les octets ; seules les métadonnées suivent les règles ci-dessus. |
| Conflit « irréconciliable » (ex. sémantique) | Enregistré dans `sync_conflicts`, visible dans l'UI avec les deux versions et choix manuel. |

### 8.5 États visibles
`hors ligne · synchronisation · à jour · conflits à résoudre · erreur (avec cause)`, compteur d'opérations en attente. **Aucun état « synchronisé » sans accusé serveur réel.**

### 8.6 Fichiers
Upload par blocs reprenables vers Supabase Storage (bucket privé, chemin `space_id/hash`), file d'attente dédiée, vérification de hash après transfert, politiques Storage alignées sur les permissions de l'objet associé.

## 9. Collaboration temps réel (CRDT)

- **Modèle** : un `Y.Doc` par page. Mises à jour Yjs incrémentales (`doc_updates`) + instantanés compactés (`doc_snapshots`).
- **Transport** : canal **Supabase Realtime Broadcast** privé par page (autorisation via RLS sur `realtime.messages`) **utilisé comme simple tuyau** de diffusion ; Realtime n'est pas le CRDT. Présence + curseurs via Realtime Presence / awareness Yjs.
- **Persistance** : chaque mise à jour est aussi envoyée (par lot, debounce) à la table `doc_updates` via RPC soumise à RLS ⇒ un client hors-ligne récupère l'état par `state vector` diff à la reconnexion. Compaction périodique (Edge Function planifiée) en snapshot ; rétention configurable.
- **Reprise après déconnexion** : le client continue d'éditer localement (états Yjs en SQLite), puis échange `stateVector`/diff à la reconnexion ; fusion sans perte par construction.
- **Limites documentées** : croissance des mises à jour (compaction), pas de chiffrement de bout en bout, latence dépendante de Realtime, historique par utilisateur approximé via attribution des mises à jour (métadonnées `author_id` par update), pas de fusion sémantique des conflits de structure (ex. deux conversions de bloc concurrentes → résultat Yjs déterministe mais parfois surprenant), taille max de document recommandée.
- **Ne sera annoncée comme « temps réel » qu'une fois les tests multi-clients passés** (Phase 8). Avant : indiquée comme non disponible.

## 10. Authentification et modes

- **Invité** : aucune dépendance réseau, `workspace_owner = local`. **Connecté** : Supabase Auth (email + mot de passe). Jetons de session stockés dans le **trousseau OS** (Keychain / Credential Manager) via Rust, pas dans `localStorage`.
- **Migration invité → compte** : machine à états persistée (`migration_jobs`) : *analyse → prévisualisation (doublons, conflits) → upload par lots idempotents → vérification d'intégrité (comptages + hashes) → bascule*. Reprenable à chaque étape ; les données locales ne sont jamais supprimées avant vérification.
- **PIN** : verrou local indépendant (hash Argon2id + sel, compteur de tentatives avec délai croissant, stocké en base locale / paramètres ; secret de verrouillage jamais envoyé au cloud).

## 11. Automatisations

- Définition : déclencheur → conditions → actions (liste ordonnée, délais). Stockée comme données (JSON validé par schéma).
- **Exécution locale** (mode invité, appareil actif) : moteur Rust piloté par l'événement `data-changed` + planificateur ; **cloud** (comptes) : Edge Function déclenchée par triggers/`pg_cron`, exécutée **avec l'identité du créateur** (jeton délégué restreint) ⇒ soumise à RLS, **jamais de service_role** pour contourner les permissions.
- Anti-boucle : profondeur de chaînage maximale, `origin_automation_id` sur chaque écriture (une automatisation ne se redéclenche pas elle-même), budget d'exécutions par fenêtre, disjoncteur → désactivation + notification.
- Historique d'exécution + erreurs par étape ; exécution idempotente (clé = règle + événement).
- Éviter le double déclenchement local/cloud : un seul « propriétaire d'exécution » par règle (champ `runs_on`).

## 12. Gestion des erreurs, logs, configuration

- Rust : `thiserror` + type d'erreur sérialisable (`code`, `message_clé_i18n`, `retryable`). Front : `ErrorBoundary` par feature, toasts typés, jamais d'erreur avalée.
- Logs : `tracing` (fichier rotatif local, niveaux, **redaction** des contenus utilisateur et secrets). Export de diagnostic à la demande.
- Config : `.env` (Vite) pour `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` uniquement (clé publique, protégée par RLS) ; absence ⇒ l'app démarre en mode invité et masque proprement le cloud. `service_role` jamais côté client ni dans le dépôt.

## 13. Internationalisation et accessibilité

`i18next` (FR/EN, pluriels ICU, namespaces par feature), `Intl.*` pour dates/nombres/fuseaux. Composants d'UI sur **primitives accessibles non stylées** (Radix UI, MIT) habillées par le design system Slate ; focus visible, contrastes WCAG AA, `prefers-reduced-motion`.

## 14. Build et livraison

- Dev : `pnpm tauri dev`. Build : `pnpm tauri build` (macOS x64/arm64 → `.dmg`, Windows → `.msi`/NSIS).
- CI GitHub Actions : matrice `macos-latest` (arm64) + `macos-13` (x64) + `windows-latest` ; lint, typecheck, tests Vitest/cargo, e2e, `gitleaks`, `cargo audit`/`pnpm audit`, build de bundles.
- Builds reproductibles : `Cargo.lock` et `pnpm-lock.yaml` versionnés, versions d'outils épinglées (`rust-toolchain.toml`, `.nvmrc`, `packageManager`), `--locked`/`--frozen-lockfile`.
- Signature/notarisation : hors périmètre technique tant que les certificats ne sont pas fournis (documenté ; builds non signés signalés comme tels).
