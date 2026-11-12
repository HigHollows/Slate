# Slate — Stratégie de tests

Règle : une fonctionnalité n'est « terminée » que si ses tests pertinents passent **et** qu'elle fonctionne dans l'UI réelle. « Ça compile » ne suffit jamais.

## 1. Pyramide et outils

| Niveau | Outil | Cible |
|---|---|---|
| Unitaire TS | **Vitest** | packages purs (`formula`, `sync-protocol`, `schema`), services de features, utilitaires. |
| Property-based | **fast-check** (TS) / **proptest** (Rust) | convergence de sync, parseur de formules, fractional indexing, HLC. |
| Unitaire/intégration Rust | `cargo test` (SQLite en mémoire + fichiers temporaires) | migrations, commandes IPC, FTS5, oplog, backups, PIN. |
| Composants | **Testing Library** + Vitest (jsdom) + `vitest-axe` | design system, menu `/`, cellules de table, palette. |
| Intégration front↔Rust | `tauri` mock IPC / tests de commandes | contrat IPC typé. |
| E2E desktop | **WebdriverIO + tauri-driver** (Windows/Linux) ; sur macOS (pas de WKWebDriver pour Tauri) : e2e sur le build web avec **Playwright** + mock IPC, complétés par tests manuels outillés | parcours critiques. *Limite connue : e2e natif macOS limité.* |
| Base cloud / RLS | **Supabase CLI local + pgTAP** | policies, `apply_ops`, invitations. |
| Multi-clients (collab) | Playwright multi-contextes contre Supabase local | convergence Yjs, permissions Realtime. |
| Perf | benchmarks Vitest bench / criterion | seuils en CI. |
| Sécurité | `gitleaks`, `pnpm audit`, `cargo audit/deny`, tests de non-régression RLS, fuzz formules | |

## 2. Tests obligatoires par domaine

**Migrations** : appliquer toutes les migrations sur base vide ; sur snapshots de chaque version antérieure (fixtures SQLite versionnées) ; checksum modifié → refus ; base plus récente que l'app → refus ; sauvegarde pré-migration créée ; migration interrompue (kill) → reprise/rollback cohérent.

**Persistance / fiabilité** : écritures atomiques (mutation + oplog dans la même transaction) ; **injection de panne** (erreur disque simulée, kill -9 en cours d'écriture) → pas de corruption, pas de perte silencieuse ; `integrity_check` après chaque scénario.

**Synchronisation** : simulateur déterministe (horloge, réseau et ordre des messages contrôlés) :
partition réseau, opérations rejouées/dupliquées (idempotence), dérive d'horloge, crash en milieu de lot, deux appareils modifiant le même champ / champs différents, suppression vs modification, déplacements cycliques, reprise après long hors-ligne, pull paginé interrompu.
Propriété centrale : *tous les réplicas qui ont reçu le même ensemble d'opérations convergent vers le même état*, quel que soit l'ordre (property-based).

**Collaboration** : convergence Yjs avec 2–3 clients ; édition hors-ligne puis reconnexion ; rôle `viewer` rejeté (RLS + Realtime) ; compaction ne perd rien (état avant == après).

**Permissions** : matrice automatisée rôle × table × opération × (membre / non-membre / invité par page) ; tentative de lecture inter-espaces par ID forgé ; automatisation sous identité sans droit → refus ; Storage idem.

**Restauration** : restaurer une version de page ; restauration sélective ; base locale corrompue → restauration depuis sauvegarde ; corbeille → restauration avec enfants ; export → réimport (aller-retour) ; sauvegarde cloud → restauration sur machine vierge.

**Éditeur** : transformations de blocs, collage (HTML/Markdown/texte), undo/redo, DnD, migration de schéma de document, autosave sous échec (le buffer reste, l'erreur est visible).

**Base de données (module)** : chaque type de propriété (validate/serialize/compare/filtres) ; filtres ET/OU imbriqués ; tri multiple ; groupes ; formules (cycles, erreurs, limites) ; cohérence multi-vues ; 100 k lignes (perf).

**Automatisations** : déclencheurs/conditions/actions ; anti-boucle ; idempotence ; échec partiel d'une chaîne ; désactivation.

**PIN** : jamais en clair dans la base/logs ; délai après échecs persistant au redémarrage ; verrouillage inactivité (horloge simulée).

**i18n/accessibilité** : clés manquantes FR/EN détectées en CI ; `axe` sans violation sérieuse sur chaque écran ; navigation clavier de bout en bout sur parcours clés ; `prefers-reduced-motion`.

**Import/Export** : fixtures réelles (export Notion anonymisé), rapport d'incompatibilités, reprise après interruption, détection de doublons.

## 3. Intégration continue
GitHub Actions : `lint → typecheck → unit → cargo test/clippy → composants → build (macOS x64 + arm64, Windows) → e2e → audits`. Une PR n'est mergeable que si tout est vert. Couverture suivie (pas de seuil aveugle ; seuils élevés sur `sync-protocol`, `formula`, `db`).

## 4. Données de test
Générateur de jeux de données volumineux (seedé) ; fixtures versionnées ; **aucune donnée personnelle réelle** dans le dépôt.

## 5. Ce qui ne pourra pas être automatisé (à déclarer)
Rendu natif sur matériel Apple Silicon et sur Windows réel, lecteurs d'écran (VoiceOver/NVDA), installation sur machine vierge : vérifications manuelles consignées dans les rapports de phase, signalées comme telles tant qu'elles n'ont pas été faites.

## 6. État réel après la Phase 3

- **Rust** (`cargo test`) : arbre (cycles, profondeur, cascade, restauration groupée, purge), positions fractionnaires (2 000 insertions aléatoires), contenu (aller-retour binaire, **injection de panne en cours de transaction**, relecture après abandon de la connexion), recherche (accents, préfixes, injection FTS, isolation par espace), liens/rétroliens.
- **Vitest** : `SaveManager` (horloges simulées : regroupement, échec/reprise, flush qui rejette, libération), modèle d'arbre et calcul de dépôt, stores, extraction des liens, menu `/`, et **intégration UI** (jsdom + vrai Tiptap/Yjs) : annuler/rétablir (Yjs), déplacement de blocs au clavier, création, titre, enregistrement du contenu, absence d'écriture parasite, retour sur la page, sortie immédiate, échec + reprise, arbre au clavier, glisser-déposer, déplacement, favoris, corbeille, palette, menu `/`, mentions, rétroliens, axe.
- **Non couvert** : e2e dans la vraie fenêtre Tauri (aucun), poignée de glisser des blocs (**non vérifiée visuellement**), performance sur de gros volumes (benchmarks absents), arrêt brutal réel du processus (seulement simulé côté SQLite).

## 7. État réel après la Phase 4

- **Rust (95)** : migration 0003 (données v2 conservées, cascade non déclenchée, index recréés, échec = v2 intacte et clés réactivées, violation FK détectée, sauvegarde valide), SAVEPOINT imbriqués, positions (50 000 ajouts, anciennes clés), validation de **chaque type** de valeur (dates impossibles, URL `javascript:`, e-mails, nombres hors limites…), lots atomiques, relations à double sens (y compris auto-relation, lignes d'une autre base, supprimées, identifiants forgés), conversions sans perte, nettoyage d'options, corbeille/restauration/purge d'une base et de ses lignes, recherche des valeurs, volume (1 500 lignes).
- **Formules (38)** : opérateurs, fonctions, dates à horloge injectée, syntaxe, **tentatives d'exécution de code** (`constructor`, `__proto__`, `eval`…), limites de ressources, fuzz de 15 000 entrées.
- **Moteur de requêtes (32)** : tous les opérateurs de filtre, ET/OU imbriqués, tris stables avec vides en dernier, groupes, agrégations, conversions texte↔valeur, **100 000 lignes < 2 s**.
- **Store (11) + intégration UI (26)** : édition tableur au clavier, collage/copie TSV, plage, échec avec annulation par cellule, filtres/tris/recherche, partage des données entre les 4 vues, glisser de cartes kanban, ligne ouverte comme page, relations, virtualisation, axe sur tableau/kanban/liste/galerie.
- **Non couvert** : application Tauri réelle (aucun e2e), rendu visuel des vues de base (non vérifié dans un navigateur), performance de l'interface sur 100 000 lignes (seul le moteur est mesuré), glisser-déposer réel à la souris (événements simulés).

## 8. État réel après le bloc productivité

Rust 96 (migration 0004 : vues conservées, `calendar` accepté, index recréés) · calcul calendaire 8 (mois bissextiles, grilles de 4 à 6 semaines, **fuseaux Auckland / Los Angeles / Paris, changement d'heure**) · intégration 7 (modèle de tâches complet, cohérence statut/échéance/sous-tâche/retard, calendrier : placement, glisser, menu clavier, création depuis un jour, planification, navigation, vue semaine, « + n », état vide, axe). Total : Rust 96, formules 38, interface 186, icônes 3 — tous verts, lint/clippy/TypeScript/i18n (473 clés) propres.
Non vérifié : rendu visuel du calendrier, build de production avec la migration 0004 (non relancé), interactions souris réelles.

## 9. État réel après comptes, récurrence, rappels, objectifs, habitudes
`pnpm check` (lint, TypeScript, tests, i18n 590 clés, cargo test, clippy) : **vert**. Rust 124 · interface 247 · formules 38 · icônes 3.
- **Comptes** (32 + 5) : client REST (endpoints, en-têtes, erreurs, délais, encodage), store (initialisation, hors ligne, jeton révoqué, trousseau en échec, renouvellement), interface (connexion, refus, inscription avec confirmation, mot de passe oublié, déconnexion, axe). Trousseau Rust : tests avec entrée simulée.
- **Récurrence** (Rust) : intervalles (fin de mois, bissextile, changement d'année), rôles validés, création atomique de l'occurrence, pas de doublon, pas de suite sans règle/échéance/rôles ; l'occurrence apparaît dans l'interface sans rechargement.
- **Rappels** : échéances, acquittement idempotent, changement d'heure, tâche terminée/supprimée, horloge invalide (Rust) ; boucle d'interrogation : ordre, échec de notification, chevauchement (TS).
- **Habitudes/objectifs** : statistiques pures (séries, fenêtres, bissextile, jours locaux), pointage Rust (idempotent, futur, non-habitude, supprimée), interface (pointer/dépointer, annulation sur refus, axe).
- **Non vérifié** : inscription réelle sur Supabase ; **notification système réelle** (permission macOS/Windows, application signée) ; rappels après redémarrage dans l'application réelle ; rendu visuel des écrans Compte/Habitudes ; build de production avec les migrations 6 et 7 ; Windows et Apple Silicon.

## 10. Éditeur riche (première tranche)
Vitest : modèle de formatage (validation de couleurs/polices/tailles, conversion du CSS collé, luminance), éditeur réel (formats combinés, exclusivité indice/exposant, sélection partielle, refus des valeurs invalides, retrait ciblé et complet, titres 1–6, alignement, interligne), **persistance** (état Yjs rouvert et JSON de secours rechargé : HTML identique), **sécurité** (scripts, `onclick`, iframes, `javascript:`, `position`, tailles absurdes), interface (barre d'outils accessible axe, états, couleurs, HEX invalide, listes, styles, réouverture de page, raccourcis), statistiques. Non vérifié : rendu visuel réel de la barre et des palettes (clair/sombre), lecteurs d'écran, collage depuis de vrais Word/Google Docs (seulement du HTML d'exemple).

Tranche 2 (blocs et tableaux) : modèle — encadrés typés (variante inconnue → note, retrait, ancien format), bloc repliable (aller-retour Yjs), sommaire (hiérarchie, mise à jour, navigation, injection de HTML dans un titre), tableaux (lignes, colonnes, en-têtes, fusion/division, fond validé, suppression, largeur de colonne et fond conservés, HTML collé nettoyé) ; interface — barre de tableau, menu `/`, type d'encadré, sommaire, bloc repliable, axe. Non vérifié : rendu visuel (bordures colorées, flèche du bloc repliable, poignées de redimensionnement) et glisser réel à la souris des colonnes.

Tranche 3 (images et code) : Rust (4) — aller-retour idempotent adressé par contenu, type déduit des octets, SVG/HTML/exécutable refusés, taille bornée (20 Mo exacts acceptés, +1 octet refusé), traversée de chemin, altération du fichier détectée. Éditeur — attributs d'image validés (hash, alignement, largeur refusés si invalides, alt sans saut de ligne), aller-retour Yjs, HTML collé sans `<img src>` ; code — langage validé, numéros, repli, aller-retour, code non interprété comme HTML, coloration produite pour chacun des 14 langages ; interface — insertion depuis le disque, jamais de base64 dans le document, options, aperçu, suppression, collage d'une image, refus d'un SVG signalé, copie/langage/numéros/repli du code, axe. Non vérifié : rendu visuel (images, coloration, flèches), glisser-déposer réel de fichiers depuis le Finder, très grosses images, vrai presse-papiers.

Tranche 4 (recherche et versions) : Rust (7) — première version, une automatique au plus toutes les 10 min, page vide, nommer sans doublon, entrées invalides, conservation 24 h / quotidienne / 30 jours / plafond de 100, manuelles jamais supprimées, suppression avec la page purgée. Éditeur (7) — occurrences à travers les marques, casse, mots entiers avec accents, caractères spéciaux littéraux, navigation circulaire, remplacement conservant le gras et annulable, absence de boucle, calcul rapide sur 5 000 paragraphes ; différences (3, dont une propriété sur 200 cas aléatoires) ; interface — barre de recherche (Ctrl+F, compteur, casse, tout remplacer, Échap, axe), versions (enregistrer, comparer, restaurer avec sauvegarde préalable, échec de la sauvegarde = rien de restauré, axe). Non vérifié : rendu visuel, performance du rendu des surlignages dans un vrai navigateur, comportement sur de très longs historiques, restauration d'une version créée avant une évolution du schéma de document.

Tranche 5 (modes d'écriture) : préférence de largeur (défaut, relecture, valeur invalide → défaut, refus à l'écriture) ; interface — mode lecture (non modifiable, commandes masquées, titre en lecture seule, aucune écriture même en tapant, hiérarchie conservée, retour en édition, axe, raccourci, recherche sans remplacement, non mémorisé), mode focus (barre latérale et en-tête masqués, édition conservée, Échap, bouton, raccourci, Échap prioritaire pour la recherche), largeur (4 choix appliqués, enregistrés, « actuel » indiqué). Non vérifié : rendu visuel du centrage et des barres masquées, transitions, lecteurs d'écran, comportement du plein écran de la fenêtre.

Tranche 6 (commentaires) : Rust (5) — cycle de vie complet d'un fil, suppression du dernier message = suppression du fil, entrées invalides (UUID, vide, trop long, auteur, page inconnue ou en corbeille, doublon), isolement par page, purge. Éditeur (6) — ancrage qui suit les insertions avant/après/dans le passage, modifications concurrentes entre deux copies Yjs, suppression du texte ancré, chevauchement, identifiants invalides, copier-coller sans duplication, aller-retour Yjs ; interface (4) — fil complet (création, réponse, modification, résolution, réouverture, axe), suppression de message et de fil avec retrait de l'ancrage, sélection vide, échec de création sans ancrage, fil orphelin, ouverture depuis le document, lecture seule. Non vérifié : rendu visuel du panneau et des surlignages, clic réel sur un passage (événement simulé), comportement sur de très gros documents, couper-coller d'un passage commenté.

Tranche 7 (collage et liens) : Rust (2) — validation des adresses ouvrables (accepte http/https/mailto, refuse 16 formes dont schémas inconnus, hôtes vides, identifiants, espaces, retours à la ligne, > 2 000 caractères). Liens (4) — acceptation/refus (25 cas), normalisation de la saisie, identifiants de page, affichage ; éditeur (2) — document filtré au chargement et à la pose d'un lien, rétroliens depuis les liens internes. Collage (8) — détection de source et politique, site web normalisé, Word/Docs conservés (conteneur « gras » de Docs, `mso-*`, `o:p`), listes Word imbriquées, modes explicites, HTML malveillant (scripts, iframe, object, svg, style, form, `on*`, `javascript:`, `data:`, éléments cachés), tableaux, texte brut sans HTML. Interface (6) — lien sur sélection avec refus de `javascript:`, insertion avec texte, lien vers une page de Slate, carte (ouvrir, copier, retirer), Ctrl+clic et lecture seule, menu « Coller » (3 modes, Word, texte brut, presse-papiers illisible). Non vérifié : vrais documents Word / Google Docs / pages web, comportement du presse-papiers du système et de ses autorisations, ouverture réelle du navigateur et du client de messagerie, survol de la carte au pointeur réel (seul le chemin du curseur est testé).

Tranche 8 (listes et paragraphes) : modèle (10) — styles de liste (puces et numérotations, refus croisés et injection), HTML étranger, retraits (montée/descente, bornes 0 et 8, plusieurs blocs, titres, retrait droit), retrait dans une liste = imbrication, espacements (valeurs prédéfinies, refus, retrait d'une valeur, réinitialisation), marges collées ignorées, réouverture Yjs, progression des tâches (calcul imbriqué, mise à jour, activation), déplacement d'éléments (bords, curseur qui suit, hors liste), sortie de liste. Préférence « barré » (validation, application, relecture). Interface (6) — barre de liste (style, monter/descendre, axe), Tab / Maj+Tab / Alt+Maj+↓ / Entrée×2, progression annoncée et mise à jour en cochant, menu ¶ (retraits, espacements, réinitialisation, axe), raccourcis de retrait, réglage Apparence. Non vérifié : rendu visuel (puces en tiret, chiffres romains, barre de progression), lecteurs d'écran sur la barre de progression, comportement sur de très longues listes.

## Synchronisation (première tranche)
SQL sur le vrai projet : 36 assertions (`supabase/tests/sync.sql`). Rust : 10 (`sync/tests.rs`). TypeScript : client 5, moteur 14, interface 5. Voir `docs/SYNC.md` pour ce qui n'est PAS vérifié (aucun bout en bout avec un vrai compte).

Bases de données synchronisées : SQL 34 assertions (`supabase/tests/sync_databases.sql`, vrai projet), Rust +11 (schéma par champ, vues, cellules ajoutées/modifiées/retirées, création de ligne, application distante sans écho, préservation du local en attente, doublon de nom, curseur bloqué, rattrapage), TypeScript +6 (flux, pagination, reprise, erreurs, contrôleur). Réel : bases/propriétés/vues de l'installation envoyées sans refus. Non vérifié : lignes avec valeurs en réel, second appareil.

## Invitations et espaces partagés
SQL (vrai projet, annulé après coup) : 41 assertions `supabase/tests/invitations.sql` (rôles, jeton haché, expiration, mauvaise adresse, réutilisation, plafond de 50, révocation, rétrogradation interdite). Rust : synchronisation multi-espaces (adhésion, regroupement des opérations par espace, lecteur sans envoi, accès retiré, réception sans écho, désactivation globale) + ordre des espaces. TypeScript : moteur par espace, client, partage (création d'invitation, jeton en lecture seule affiché une fois, rejoindre, jeton refusé), magasin des pages (changement d'espace mémorisé, lecteur). Non vérifié : deux vrais comptes de bout en bout, second appareil, rendu visuel.

Commentaires partagés : SQL 24 assertions (`supabase/tests/comments.sql`, vrai projet : droits, auteur non usurpable, fusion, flux, purge, anonyme), Rust +9 (inscription fil avant message avec espace, résolution/modification/suppression, purge de page sans bruit, invité, activation avec l'existant, réception sans écho, ordre fil/message, modification locale préservée, contenu invalide), TypeScript : panneau (relecture après synchronisation, droits sur les messages d'autrui). Non vérifié : deux comptes réels.

Présence en direct : SQL 20 assertions (`supabase/tests/realtime_presence.sql` : politiques en place, rôles, sujets valides/croisés/purgés, anonyme), TypeScript : transport (jonction privée avec jeton, refus, reconnexion, trames hostiles, fermeture) 9, session (convergence à deux, regroupement, arrivée en cours, curseurs relatifs, lecteur muet, pas d'écho, coupure, entrées hostiles, état invalide, auto-écrasement) 20, interface (présents, curseur distant dessiné avec le nom en texte, détachement). Non vérifié : vrai serveur Realtime, deux comptes réels.

E-mail d'invitation : SQL 22 assertions (`supabase/tests/invitation_email.sql` : destinataire lu en base, plafonds, réservation rendue, rôles, jeton inconnu, révoquée/expirée/acceptée, anonyme), fonction Edge 12 tests avec faux fournisseur (destinataire non pilotable, jeton de l'appelant, non configuré avant toute réservation, entrées invalides, CORS, refus/limite, réservation rendue en cas d'échec, échappement/injection d'en-têtes), interface 5 (envoi, case décochée, non configuré, échec + renvoi, limite). Vérifié en réel : la fonction est déployée et répond (401 sans jeton d'utilisateur, prévol CORS). Non vérifié : tout envoi réel (aucune clé de fournisseur).

Partage ciblé : SQL 41 assertions (`supabase/tests/node_sharing.sql` : invitation par administrateur seulement, jamais « administrateur », acceptation = partage et non adhésion, lecture limitée à l'élément et ses descendants, parent masqué, aucune fuite de titre, écriture refusée hors partage opération par opération, impossibilité de déplacer/supprimer/purger l'élément partagé, présence, retrait immédiat, membres inchangés) + vérification que l'invitation d'espace entier fonctionne toujours ; TypeScript : fenêtre « Partager… » (invitation ciblée, liste/retrait, sans synchronisation), moteur (espace en portée « partagé »).
Mises à jour : 10 tests (logique : indisponible hors application, à jour/disponible, pas d'installation sans annonce, progression, erreurs, option automatique ; contrôle périodique ; interface). Non vérifié : téléchargement signé réel.
Fonctions : note du jour (idempotente), dupliquer (contenu même non enregistré), copier en Markdown (convertisseur pur : marques, listes imbriquées, tâches, tableaux, code, liens sûrs, échappements).
