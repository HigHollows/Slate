# Rapport de Phase 4 — Bases de données

Date : 2026-11-07. Machine : macOS 13.7.8 Intel.

## Terminé (vérifié)
- **Modèle** : migration 0003 (base, propriétés, lignes, vues, compteur d'identifiants) ; chaque ligne est une page enfant de la base (D-030) ; 19 types de propriétés dont relations à double sens, formules et identifiants automatiques ; validation de chaque valeur dans le cœur Rust.
- **Vues** : tableau (édition type tableur, plage, copier/coller TSV atomique, virtualisation, redimensionnement, agrégations), kanban (glisser + menu clavier), liste, galerie ; filtres ET/OU imbriqués, tris multiples, regroupement, recherche dans la vue, vues multiples enregistrées.
- **Formules** : package `@slate/formula` sans `eval`, limites de ressources, 15 000 entrées de fuzz.
- **Ligne = page complète** avec panneau de propriétés, éditeur, mentions, recherche des valeurs textuelles.
- **Migration réelle** : la base de développement a été migrée de v2 à v3 par le binaire de production (sauvegarde pré-migration créée, `integrity_check` = ok, `foreign_key_check` vide, données conservées).

## Tests exécutés
Rust 95 · formules 38 · interface 169 · icônes 3 · axe 0 violation · clippy/ESLint/tsc/i18n (430 clés) 0 erreur. Détail : `TESTING.md` §7.

## Build
`cargo build --release` + bundle `Slate.app` : **réussis** (macOS Intel). Le `.dmg` n'a pas pu être produit : `bundle_dmg.sh` pilote le Finder par script (mise en forme de la fenêtre) et reste bloqué dans cet environnement (déjà observé en Phase 3 : « ressource occupée »). Non lié au code ; contournement : `pnpm build:app` (bundle `.app` seul). Le `.dmg` doit être vérifié depuis une session graphique avec l'autorisation « Automatisation » du Terminal sur Finder. Windows et Apple Silicon : non construits.
Un processus `bundle_dmg.sh` et une image disque résiduelle peuvent rester actifs après ce blocage : ils n'ont pas été arrêtés automatiquement (à éjecter manuellement, `hdiutil info`).

## Limites (voir aussi D-030…D-039)
Types personne/fichier/rollup non faits ; vue calendrier (Phase 5) ; pas de sélecteur de calendrier ; tableau non groupable ; réordonnancement des colonnes par menu (pas par glisser) ; calcul des requêtes côté client sur toutes les lignes (100 000 lignes mesurées en test unitaire, pas dans l'application) ; rendu visuel des vues de base et interactions souris réelles non vérifiés ; aucun test de bout en bout dans la fenêtre Tauri.

## Prochaine étape recommandée
Validation par l'utilisateur, puis Phase 5 (tâches, calendrier, objectifs, habitudes) — en s'appuyant sur les bases : une tâche sera une ligne d'une base système (D-014).
