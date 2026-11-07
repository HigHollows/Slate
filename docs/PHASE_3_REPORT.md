# Rapport de Phase 3 — Gestion des pages

Date : 2026-11-07. Machine : macOS 13.7.8 Intel.

## Terminé (vérifié)
- **Arbre de contenus** : dossiers, pages, sous-pages (profondeur ≤ 32, pas de cycle), favoris, récents, corbeille avec restauration groupée et suppression définitive (uniquement depuis la corbeille, journalisée), déplacement par glisser-déposer **et** par boîte « Déplacer vers… », navigation clavier complète (flèches, F2, Suppr).
- **Éditeur** Tiptap + Yjs (annuler/rétablir), blocs : texte, titres 1-3, listes à puces/numérotées/tâches, citation, encadré, code, séparateur, tableau, liens (http/https/mailto), mentions de pages avec rétroliens ; menu `/` (catégories, recherche, clavier, transformation d'un bloc existant), barre de mise en forme, déplacement de bloc au clavier (Alt+Maj+↑/↓).
- **Enregistrement fiable** : contenu + index + liens en une transaction ; jamais d'abandon silencieux (reprise automatique, erreur visible, `flush` qui rejette), fermeture de fenêtre annulée si l'écriture échoue.
- **Recherche locale** FTS5 (hors ligne, sans accents), intégrée à la palette.
- Vérifié dans l'application réelle : migration v1→v2 avec sauvegarde pré-migration, création de l'espace par défaut par l'interface, et une page créée/modifiée/mise à la corbeille manuellement par l'utilisateur sur le build de production.

## Tests (état à la fin de la phase)
Rust 55 · JS 100 (dont 28 d'intégration avec le vrai Tiptap/Yjs sous jsdom) · axe 0 violation · clippy/ESLint/tsc 0 erreur.

## Défauts trouvés et corrigés
Champ de renommage qui ré-sélectionnait le texte à chaque frappe ; purge d'un dossier échouant sur la contrainte de clé étrangère ; `.ok()` qui masquait une erreur SQL (identifiant d'appareil) ; commandes absentes de la palette après un remplacement automatique raté.

## Limites
Un seul espace (« Personnel ») sans interface de gestion ; images/vidéos/fichiers/équations, commentaires, historique de versions, mode lecture, épingles, sélection multi-blocs et filtres de recherche non faits ; tableaux sans boutons d'ajout de lignes/colonnes ; poignée de glisser des blocs non vérifiée visuellement ; arbre non virtualisé ; état Yjs complet réécrit à chaque enregistrement (D-023) ; `dragDropEnabled=false` (impact Phase 9, D-027) ; aucun test de bout en bout dans la fenêtre Tauri ; Windows / Apple Silicon non testés.
**Livraison** : `Slate.app` construit ; l'empaquetage `.dmg` a échoué une fois (`hdiutil: ressource occupée`, image disque résiduelle de l'environnement, détachée ensuite) — non lié au code.
