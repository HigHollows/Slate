# Slate — Roadmap

Principe : chaque phase se termine par un état **compilable**, des **tests verts**, une doc à jour et un **rapport de phase** (terminé / partiel / non commencé, fichiers, tests et résultats, problèmes, décisions, prochaine étape).
Aucune estimation de durée n'est promise : la qualité prime sur la vitesse.

Légende risque : 🔴 élevé · 🟠 moyen · 🟢 faible.

## Phase 0 — Analyse et préparation ✅ (ce livrable)
Livrables : 7 documents, inventaire de l'environnement, décisions initiales.
Reste à valider par l'utilisateur : D-001…D-012 (voir `DECISIONS.md`, notamment D-004, D-009, D-011).

## Phase 1 — Fondations techniques 🟢
Tauri 2 + React + TS strict + Vite + Tailwind, monorepo pnpm, SQLite (rusqlite) + migrations + tests de migration, gestion d'erreurs, logs, i18n minimal, ESLint/Prettier/clippy, Vitest + cargo test, CI (macOS x64/arm64, Windows), config d'environnement.
**Critères d'acceptation**
- `pnpm install --frozen-lockfile && pnpm tauri build` produit un bundle sur macOS (local) ; CI vert sur Windows.
- Au démarrage : la base est créée, migrée (checksum vérifié), un `ping` IPC aller-retour typé passe en test.
- Lancer l'app avec une base plus récente que le binaire → refus explicite (test).
- Absence de `.env` → démarrage en mode invité sans erreur.
- Lint + typecheck + tests : 0 erreur ; règle anti-import croisé active.

## Phase 2 — Identité et interface principale 🟠
Design system (tokens, thème clair/sombre, accent configurable, densité, taille de texte), intégration **Papicons vendus**, inventaire des icônes manquantes + équivalents typographiques, barre latérale personnalisable, menus, palette `Ctrl/Cmd+K` (framework de commandes + registre), paramètres, états vides/erreur/chargement.
**Critères** : toutes les actions visibles sont câblées (zéro bouton mort) ; navigation clavier complète ; contrastes AA vérifiés (axe) ; `prefers-reduced-motion` respecté ; tests de composants ; captures validées en clair/sombre.

## Phase 3 — Gestion des pages 🔴 (éditeur) — voir docs/PHASE_3_REPORT.md
Espaces, dossiers, pages, sous-pages, éditeur Tiptap + Yjs local, blocs de base, menu `/`, autosave fiable, favoris/récents, recherche FTS5, corbeille de base, DnD arborescence.
**Critères** : kill -9 pendant l'édition → au plus la dernière frappe en vol perdue, jamais de corruption (test automatisé) ; échec d'écriture simulé → buffer conservé + erreur visible ; recherche accentuée FR < 50 ms sur 10 000 pages (benchmark) ; liens internes/backlinks.

## Phase 4 — Bases de données 🔴
Registre de propriétés, vues table/kanban/liste/galerie/calendrier (calendrier complet en Phase 5), filtres ET/OU, tris, groupes, relations, agrégations, formules (package dédié), édition de cellules type tableur, virtualisation.
**Critères** : modif dans une vue visible dans les autres sans rechargement ; 100 000 lignes fluides (benchmark) ; fuzzing du parseur de formules, aucune exécution de code arbitraire ; changement de type de propriété non destructif.

## Phase 5 — Productivité 🟠
Tâches (base système), sous-tâches, dépendances, récurrence, rappels (notifications OS), suivi du temps, calendrier m/s/j, objectifs, habitudes, séries, stats.
**Critères** : une tâche modifiée est identique dans toutes les vues ; récurrence testée (fuseaux, changement d'heure) ; rappels fiables après redémarrage.

## Phase 6 — Tableaux de bord et automatisations 🟠
Dashboards à widgets réels (grille redimensionnable), modèles (imbriqués, import/export), moteur Quand→Si→Alors local, historique, anti-boucle.
**Critères** : aucun widget à données fictives ; test de boucle infinie → disjoncteur ; automatisation ne contourne pas les permissions (test).

## Phase 7 — Backend et synchronisation 🔴🔴 (risque maximal)
Projet Supabase, migrations Postgres, RLS, Auth (email/mot de passe), `apply_ops`, pull par curseur, Storage, mode hors ligne, conflits, migration invité→compte.
**Critères** : suite de tests de sync déterministe (partitions réseau, rejeu, doublons d'opérations, horloges décalées, crash en milieu de lot) ; 2 appareils convergent vers le même état (propriété de convergence testée par tests aléatoires/property-based) ; pgTAP : aucun accès inter-espaces ; migration invité reprise après coupure sans perte ni doublon.
**Prérequis utilisateur** : projet Supabase (ou autorisation d'en créer un ; coût à confirmer, cf. outil de coût) et SMTP pour les emails d'invitation.

## Phase 8 — Collaboration 🔴
Invitations email, rôles lecture/édition/admin (par espace et par page), présence, curseurs, commentaires, mentions, Yjs sur Realtime + `doc_updates`, compaction, historique par utilisateur.
**Critères** : test e2e 2–3 clients éditant simultanément, déconnexion/reconnexion, convergence ; un lecteur ne peut pas écrire (RLS + Realtime) ; documentation des limites.

## Phase 9 — Fichiers, import, export 🟠
Bibliothèque, stockage local/cloud, aperçus, extraction + indexation PDF, import Markdown/CSV/JSON/Notion (prévisualisation, rapport, reprise), export complet documenté.
**Critères** : fichier de 1 Go transféré par blocs avec reprise ; import Notion réel avec rapport d'incompatibilités ; export → réimport sans perte (test aller-retour).

## Phase 10 — Sauvegardes et sécurité avancée 🟠
Sauvegardes locales/cloud, versions de pages, corbeille globale, restauration (totale et sélective), vérification d'intégrité (`PRAGMA integrity_check` + checksums), PIN (inactivité/démarrage), audit de sécurité.
**Critères** : scénarios de restauration testés (base corrompue, sync défaillante, suppression en masse) ; PIN : verrouillage après N échecs, jamais en clair (test sur la base) ; revue sécurité formelle.

## Phase 11 — Finition et livraison 🟠
Optimisation, e2e complets, tests Windows réels (VM/machine à fournir), builds de production, vérification d'installation, doc utilisateur et de maintenance, accessibilité (audit lecteur d'écran).

## Phase 12 (post-livraison, facultative) — IA
Fournisseur configurable, désactivée par défaut, consentement explicite avant envoi, plafonds de coût, aucune clé supposée.

## Risques identifiés (registre)

| # | Risque | Gravité | Mitigation |
|---|---|---|---|
| R1 | Complexité de la sync SQLite↔Postgres (divergences, perte de données) | 🔴 | Moteur dédié, package pur testé en property-based, HLC, oplog idempotent, tombstones, jamais de « synchronisé » simulé, sauvegardes indépendantes. |
| R2 | Croissance et corruption des docs Yjs | 🔴 | Compaction, snapshots, `integrity_check`, instantané JSON dérivé de secours, versions de pages. |
| R3 | RLS erronée = fuite inter-espaces | 🔴 | Tests pgTAP systématiques (matrice rôle × table × opération), fonctions `SECURITY DEFINER` minimales, `get_advisors` Supabase à chaque migration. |
| R4 | Éditeur : complexité de ProseMirror/blocs/DnD | 🟠 | Tiptap + extensions limitées ; spike d'éditeur avant Phase 3 ; tests de composants et e2e. |
| R5 | Performance des grandes bases | 🟠 | Tri/filtre en SQL, virtualisation, benchmarks en CI (seuils). |
| R6 | Catalogue d'icônes Papicons limité (≈110) | 🟠 | Équivalents typographiques/formes maison, inventaire publié, pas d'autre bibliothèque. |
| R7 | Machine de dev **Intel** sous macOS 13 ; arm64 non testable localement | 🟠 | CI arm64 ; cross-compile ; signalé comme non testé sur matériel tant que non vérifié. |
| R8 | Pas de signature/notarisation (certificats) | 🟠 | Documenter ; builds non signés étiquetés ; mises à jour auto reportées. |
| R9 | Aucun poste Windows disponible | 🟠 | CI `windows-latest` + test manuel par l'utilisateur ou VM avant Phase 11. |
| R10 | Coûts Supabase / quotas Realtime | 🟠 | Confirmer le coût avant création de projet ; limites documentées ; transport Realtime en simple diffusion. |
| R11 | Automatisations cloud et permissions | 🟠 | Exécution avec l'identité du créateur, jamais `service_role` pour contourner RLS. |
| R12 | Périmètre colossal | 🔴 | Phasage strict, critères d'acceptation, rapport honnête à chaque phase, fonctionnalités non faites = déclarées non faites. |
| R13 | Dépendances (npm/Rust) : sécurité/licences | 🟢 | Revue par dépendance (règle 6), `audit`, `cargo-deny` en CI. |
