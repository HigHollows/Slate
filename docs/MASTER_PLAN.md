# Plan d'exécution global — état réel au 2026-11-07

Légende : ✅ fait et vérifié · 🟡 partiel · ⛔ non commencé · 🔒 bloqué par une action externe.
Ce tableau confronte les 16 étapes du « Master prompt » à l'état réel. Rien n'est marqué ✅ sans test exécuté.

| # | Étape | État | Détail honnête |
|---|---|---|---|
| 1 | Analyse du dépôt | ✅ | `PHASE_1_AUDIT.md`. |
| 2 | Noyau applicatif | 🟡 | Erreurs typées, logs, configuration, stores indépendants de React, bus d'événements minimal (`shared/bus.ts`). **Manque** : bus d'événements métier typé complet (PageCreated, TaskCompleted, SyncStarted…), service de sessions/permissions, registre de modules. |
| 3 | Infrastructure locale | ✅ | SQLite (rusqlite), 7 migrations, transactions imbriquées, FTS5, sauvegarde pré-migration. **Manque** : tables utilisateurs/sessions/membres/permissions/commentaires/notifications/versions/outbox. |
| 4 | Backend cloud | 🟡 | Projet Supabase « Slate » **créé** (0 €, Paris) ; migration 1 (profils, espaces, membres, nœuds) + RLS appliquées, **40 assertions de sécurité vérifiées**, 0 alerte du conseiller (`SUPABASE.md`). **Manque** : contenu des pages, bases, tâches, Storage, outbox, Yjs, invitations ; aucun client ne s'y connecte encore. |
| 5 | Comptes et sécurité | 🟡 | Mode invité = comportement actuel. **PIN local fait** (Argon2id, blocage progressif persistant, verrou natif, inactivité, paramètres). **Compte Supabase fait côté client** : inscription (confirmation e-mail), connexion, déconnexion, mot de passe oublié, profil, session dans le trousseau du système (refresh token seul), renouvellement et reprise hors ligne — testé avec un client simulé, **aucune inscription réelle exécutée**. **Manque** : migration invité→compte (dépend de la synchronisation). |
| 6 | Synchronisation | 🟡 | **Première tranche faite** : dossiers, pages et contenu (CRDT Yjs) entre appareils d'un même compte, file locale transactionnelle, serveur testé (36 assertions sur le vrai projet), moteur testé. **Jamais éprouvée de bout en bout avec un vrai compte.** **Bases de données synchronisées** (propriétés, vues, valeurs par cellule). Manque : commentaires, versions, images, préférences, favoris, purge, temps réel, compaction (voir `SYNC.md`). |
| 7 | Design system | 🟡 | Tokens, composants accessibles, Papicons vendus, identité monochrome et logo Ω (D-040). |
| 8 | Interface principale | 🟡 | Barre latérale, palette, paramètres, pages. **Manque** : tableau de bord, panneau contextuel. |
| 9 | Éditeur | 🟡 | Voir `PHASE_3_REPORT.md`. **Manque** : images/vidéos/fichiers, équations, commentaires, historique des versions, mode lecture, sélection multi-blocs. |
| 10 | Bases de données | 🟡 | Voir `PHASE_4_REPORT.md`. **Manque** : personne, fichier, rollup, vue calendrier. |
| 11 | Productivité | 🟡 | **Fait** : vue calendrier (mois/semaine, glisser, fuseaux) pour toute base ; modèle « liste de tâches » (statut, priorité, début, échéance, progression, temps saisi à la main, sous-tâches et dépendances en relations à double sens, retard calculé, vues liste/kanban/calendrier). **Récurrence** (jour/semaine/mois/année ; l'occurrence suivante naît atomiquement quand la tâche est terminée), **rappels** (propriété date-heure « Rappel », notification dans l'app + du système, acquittement persistant, seulement application ouverte), **objectifs** (modèle de base, progression saisie) et **habitudes** (pointage quotidien, série, taux sur 30 jours, objectif hebdomadaire). **Manque** : suivi du temps par chronomètre, dépendances bloquantes appliquées, historique par tâche, projets (base liée), vue « par projet »/« personnelle »/« globale » transverses, événements (hors tâches), progression d'objectif calculée depuis les sous-objectifs (pas de cumul), rappels application fermée. |
| 12 | Modules avancés | ⛔ | Automatisations, fichiers/PDF, templates, graphe. Recherche : ✅ pour pages/lignes (FTS5), ⛔ pour tâches/fichiers/PDF. |
| 13 | Collaboration | ⛔ | CRDT Yjs déjà utilisé localement ; transport, présence, permissions : exigent Supabase. |
| 14 | Sauvegardes et portabilité | 🟡 | Corbeille et sauvegarde pré-migration ✅. Historique de versions, restauration sélective, export complet, imports : ⛔. |
| 15 | IA facultative | ⛔ | Hors chemin critique. |
| 16 | Stabilisation | ⛔ | Builds Windows/Apple Silicon jamais exécutés ; e2e dans la fenêtre Tauri jamais exécuté. |

## Ce que cette session ne peut PAS faire seule
1. **Supabase** : créer un projet (coût à confirmer, `get_cost`/`confirm_cost`) ou fournir `URL` + clé publique d'un projet dédié. Sans cela : étapes 4, 5 (comptes), 6 (bout en bout), 13.
2. **Windows / Apple Silicon** : aucune machine ; la CI GitHub Actions est écrite mais jamais exécutée (aucun dépôt distant).
3. **Signature / notarisation** : certificats non fournis.

## Ordre d'exécution retenu (dépendances)
1. Noyau applicatif complété (événements typés, sessions locales, permissions) — débloque tout.
2. Productivité locale : tâches, projets, calendrier, objectifs/habitudes (sans cloud).
3. PIN local, sauvegardes/versions, export JSON complet.
4. Fichiers locaux + PDF, templates, automatisations locales, tableau de bord.
5. Cloud (dès qu'un projet Supabase est disponible) : schéma + RLS + comptes + outbox + sync + collaboration.
6. Imports (Markdown, CSV, JSON, Notion), IA facultative, stabilisation.

## État : collaboration par espace
Fait : synchronisation par espace, invitations (jeton haché, rôles), sélecteur d'espace, lecture seule. Reste : e-mails d'invitation (SMTP), présence et curseurs, commentaires partagés, propagation de la purge, compaction des documents, essai à deux comptes réels. Détails : `docs/COLLABORATION.md`.
