# Slate — Journal des décisions

Format : contexte → décision → avantages / inconvénients → conséquences. Statut : **Proposée** (à valider) · **Acceptée** · **Remplacée**.
Rien n'est irréversible sans mention explicite. Les décisions marquées ⚠ touchent aux données, à la sécurité ou à l'architecture : validation utilisateur recommandée avant la phase concernée.

## D-001 Monorepo pnpm — Proposée
pnpm 11 déjà installé ; workspaces pour `apps/desktop` + `packages/*`. + partage des types/validation, build unifié. − outillage un peu plus lourd qu'un simple projet.

## D-002 Emplacement du dépôt — Proposée
`~/Projects/slate` (dépôt Git indépendant, distinct de `~/Projects/assistant`).

## D-003 ⚠ SQLite accédée uniquement depuis Rust (rusqlite) — Proposée
Alternatives : `tauri-plugin-sql` (SQL exposé au WebView) ; SQLite WASM dans le WebView.
Choix : rusqlite + commandes IPC typées. + surface d'attaque réduite, transactions/sync/backups/FTS5 maîtrisés côté natif, performances. − plus de Rust à écrire, contrat IPC à maintenir.
Conséquence : toute lecture UI passe par une commande ; les tests de données sont en Rust.

## D-004 Typage du contrat IPC — Proposée (à confirmer en Phase 1)
Génération de types TS depuis Rust (`specta`/`tauri-specta` ou `ts-rs`) vs schémas Zod écrits à la main. Penchant : génération depuis Rust + Zod pour les entrées utilisateur. Le choix final dépendra de la maturité de l'outil avec Tauri 2 au moment du spike.

## D-005 ⚠ Contenu de page : Tiptap/ProseMirror + Yjs — Proposée
Alternatives : Lexical (moins d'écosystème collab), BlockNote (rapide à démarrer, moins de contrôle), Slate.js (instable côté CRDT), ProseMirror nu (plus de travail).
Choix : **Tiptap (MIT)** sur ProseMirror + `y-prosemirror`. + écosystème éprouvé, collab Yjs standard, schéma extensible. − extensions Tiptap Pro (payantes) à éviter : n'utiliser que le cœur MIT ; bloc/DnD à construire. Un *spike* de 1–2 jours précède la Phase 3 (menu `/`, DnD de blocs, undo avec Yjs).
Stockage : état Yjs (source) + JSON dérivé (index/export). Conséquence : migrations de schéma d'éditeur à prévoir dès le début.

## D-006 ⚠ Sync des données structurées : oplog + HLC + fusion par champ — Proposée
Alternatives : LWW par ligne (perd des données — refusé) ; tout en CRDT (Automerge/Yjs pour toute la base : lourd, requêtes SQL difficiles) ; solutions tierces (PowerSync, ElectricSQL, cr-sqlite).
Choix : moteur maison simple et testable, SQLite classique + RPC Postgres `apply_ops` idempotente.
+ requêtes SQL normales, résolution adaptée par type, contrôle des permissions par RLS. − c'est du code critique à écrire et tester sérieusement (R1).
**Option à réévaluer avant la Phase 7** : PowerSync (Postgres↔SQLite, offline-first, licence/coût à vérifier) ; l'évaluation est notée pour ne pas réinventer inutilement, mais l'intégration avec RLS Supabase et SQLite côté Rust devra être validée.

## D-007 Realtime comme simple transport — Proposée
Yjs diffusé par Realtime Broadcast ; persistance séparée (`doc_update`) ; pull par curseur pour les données structurées. Realtime n'est jamais la garantie de livraison. Conséquence : coût/quotas Realtime à surveiller.

## D-008 État front : TanStack Query + Zustand — Proposée
Données = SQLite (via IPC) mises en cache par TanStack Query, invalidées par événements Rust ; Zustand pour l'état d'UI local (panneaux, sélection). + pas de duplication d'un store global géant. − discipline d'invalidation.

## D-009 ⚠ Pas de chiffrement au repos de SQLite en v1 — Proposée
Le PIN est un verrou d'interface, pas un chiffrement. Raison : SQLCipher complique les builds Windows/macOS et la CI ; risque de perte de données si clé perdue. Documenté dans SECURITY comme limite. Évolution possible (SQLCipher + clé en trousseau OS) avec migration dédiée. **À valider explicitement** : si la confidentialité disque est une exigence dure, il faut le décider *avant* la Phase 1 (changer après = migration lourde).

## D-010 Primitives UI : Radix UI + Tailwind — Proposée
Radix (MIT) pour l'accessibilité (menus, dialogs, popovers) habillé par le design system Slate. Alternative : tout écrire à la main (coût et risque a11y élevés). Cela n'impose pas un aspect « composants par défaut » : les styles sont entièrement les nôtres.

## D-011 Icônes : SVG Papicons vendus, pas le paquet npm — Proposée
Constats : `@getpapillon/papicons` dépend de `react-native-svg` (inadapté). Le dépôt officiel (MIT) fournit ~110 SVG.
Choix : script de génération qui lit les SVG vendus (`packages/icons/svg/`) et produit des composants React ; `THIRD_PARTY_LICENSES.md` ; version/commit source épinglés. + léger, conforme à la licence, reproductible. − mises à jour manuelles.
Manques (tableau, base de données, glisser, italique, citation, case à cocher, annuler/rétablir, image, vidéo…) : éléments typographiques ou formes géométriques minimales dessinées dans le même style, **sans autre bibliothèque ni emoji**. Inventaire en Phase 2.
Question ouverte : l'utilisateur confirme-t-il que dessiner quelques glyphes maison simples est acceptable quand Papicons n'a pas l'icône ? (le cahier des charges l'autorise : « élément graphique minimal cohérent »).

## D-012 UUID v7 et HLC — Proposée
Identifiants triables dans le temps, générés hors-ligne. HLC (Hybrid Logical Clock) pour ordonner les modifications malgré des horloges non synchronisées ; dérive excessive détectée et signalée.

## D-013 Formules : langage maison sans eval — Proposée
Parseur (Pratt) + évaluateur AST + fonctions en liste blanche + limites. Alternative (bibliothèques tierces type `mathjs`/`formula.js`) évaluée au moment de la Phase 4 selon taille/sécurité ; la surface d'exécution reste contrôlée.

## D-014 Tâches = lignes d'une base système — Proposée
Garantit « un même objet tâche, cohérent partout » et réutilise vues/filtres/relations. − la base système doit rester non supprimable et à schéma partiellement verrouillé.

## D-015 Tests e2e sur macOS — Proposée
`tauri-driver` ne couvre pas macOS (pas de WKWebView driver). Stratégie : Playwright sur le front avec mock IPC + `tauri-driver` sur Windows en CI + vérifications manuelles macOS consignées. Limite assumée et documentée.

## D-016 Build et signature — Proposée
Builds non signés tant que certificats Apple Developer / Windows indisponibles ; libellés explicites. Machine de dev Intel : cible arm64 uniquement via CI.

## Décisions à prendre par l'utilisateur (voir compte rendu)
Q1 chiffrement au repos (D-009) · Q2 création d'un projet Supabase et budget (Phase 7) · Q3 accès à un poste Windows (R9) · Q4 PIN oublié en mode invité (SECURITY § 4) · Q5 dépôt GitHub distant (visibilité).

## Décisions de la Phase 2

### D-017 Design tokens en variables CSS + Tailwind 4 `@theme inline` — Acceptée
Thèmes (`data-theme`), densité, police et échelle de texte pilotés par attributs/variables sur `<html>` ; accent et son texte (`--accent-fg`) calculés par contraste (WCAG) à l'application. Les règles de base sont dans `@layer base` pour que les utilitaires puissent les surcharger (bug réel rencontré avec l'outline de la palette).

### D-018 Préférences : SQLite via IPC, validées des deux côtés — Acceptée
Table `settings` existante ; clés `pref.*`, `ui.*`, `shortcut.*`, `history.*` (liste blanche, format `[a-z0-9._-]`, ≤ 64 car., valeur JSON valide ≤ 64 Ko, SQL paramétré). Côté UI : schéma Zod, valeur invalide ⇒ défaut sans perte des autres, mise à jour optimiste avec **annulation + toast d'erreur** si l'écriture échoue.
Limite : les préférences ne sont pas encore synchronisées (Phase 7) et les « profils de configuration » ne sont pas implémentés.

### D-019 Raccourcis : combinaisons portables `Mod+…` — Acceptée
`Mod` = ⌘ (macOS) / Ctrl (Windows). Une combinaison doit contenir Mod, Ctrl ou Alt ; combinaisons système réservées refusées ; conflits entre commandes détectés. Les touches lettres/chiffres sont lues via `event.code` (stable avec Alt sur macOS).

### D-020 Palette = registre de commandes réellement câblées — Acceptée
Aucune commande « décorative » : « Créer une page/tâche/base », recherche de contenu etc. n'apparaissent qu'avec leurs phases. Historique des 8 dernières commandes persisté.

### D-021 Radix UI (Dialog, DropdownMenu, Tooltip, Switch) + Inter variable — Acceptée
Radix MIT ; Inter (OFL 1.1) embarquée localement via `@fontsource-variable/inter` (aucun appel réseau). Mentions de licence dans Paramètres › Système et licences. `Menu` et `Switch` sont livrés dans le kit mais pas encore utilisés par un écran (utilisation prévue Phase 3) : couverts par aucun test dédié à ce stade.

### D-022 `user-select: none` global — Acceptée avec réserve
Comportement « application » ; l'éditeur (Phase 3) et les valeurs techniques doivent opter pour `select-text`.

## Décisions de la Phase 3

### D-023 Contenu des pages : Yjs (source) + JSON dérivé + texte brut, une seule transaction — Acceptée
`page_content(doc_state, content_json, text_plain)` est écrit avec l'index de recherche et les liens dans UNE transaction (test d'injection de panne : aucune écriture partielle). Le front envoie l'état Yjs **complet** à chaque enregistrement (base64 sur l'IPC). Limite connue : coût proportionnel à la taille du document ; une écriture incrémentale (journal de mises à jour + compaction) est prévue avec la collaboration (Phase 8).

### D-024 Enregistrement automatique : `SaveManager` (debounce, jamais d'abandon, tentatives en arrière-plan) — Acceptée
Le contenu est lu au moment d'écrire ; un échec laisse l'état « à enregistrer », affiche l'erreur et réessaie (1 s, 3 s, 10 s, 30 s) ; `flush()` rejette si l'écriture échoue ; à la fermeture d'une page le contenu est figé puis écrit en arrière-plan ; à la fermeture de la fenêtre Tauri la fermeture est annulée si l'écriture échoue (une seconde demande dans les 5 s force la sortie). Les mises à jour déclenchées par le montage de l'éditeur ne comptent pas comme modifications.

### D-025 Positions fractionnaires (base 62) et suppression logique avec horodatage de groupe — Acceptée
Insérer/déplacer ne réécrit jamais les frères (prérequis de la synchronisation). La corbeille restaure le sous-arbre supprimé *en même temps* (même `deleted_at`) ; un parent absent ramène l'élément à la racine. La suppression définitive n'est possible que depuis la corbeille et est journalisée.

### D-026 Mentions de pages : seul l'identifiant est stocké — Acceptée
Le titre affiché suit les renommages ; les rétroliens sont reconstruits à chaque enregistrement (cibles existantes, vivantes, hors auto-référence).

### D-027 Glisser-déposer HTML5 + alternative clavier — Acceptée, avec effet de bord
`dragDropEnabled: false` sur la fenêtre Tauri (sinon le glisser-déposer interne est intercepté sous Windows). **Conséquence : le dépôt de fichiers depuis l'OS (Phase 9) devra passer par un autre mécanisme.** Alternatives accessibles : dialogue « Déplacer vers… », Alt+Maj+↑/↓ pour les blocs.

### D-028 Recherche : FTS5 (`unicode61 remove_diacritics 2`), requête construite côté Rust — Acceptée
La saisie est découpée en mots alphanumériques, chacun en préfixe (`"mot"*`, ET implicite) : les opérateurs FTS (NEAR, OR, `:`…) ne sont jamais interprétés. Titre pondéré × 5. Extraits balisés par U+0002/U+0003, rendus sans HTML.

### D-029 `synchronous=FULL` — Acceptée
Passage de NORMAL à FULL : en mode WAL, NORMAL peut perdre les dernières transactions validées lors d'une coupure d'alimentation. Coût négligeable pour cet usage.

## Décisions de la Phase 4

### D-030 ⚠ Une ligne de base de données est un nœud « page » enfant de la base — Acceptée
Chaque ligne = `node(kind='page', parent=base)` + `db_row(props_json)`. Conséquences positives : ouverture en page complète, éditeur, mentions/rétroliens, recherche, corbeille et restauration réutilisés tels quels ; supprimer/restaurer une base emporte ses lignes (même horodatage). Conséquences : les lignes sont exclues de l'arbre latéral (`NOT EXISTS db_row`), une base ou une ligne ne peut pas contenir de sous-pages (refusé côté Rust), une ligne ne se restaure pas sans sa base.

### D-031 ⚠ Valeurs stockées en JSON par ligne (`props_json`), titre dans `node.title` — Acceptée, à revalider par benchmark
Simple et compatible avec la synchronisation par champ (Phase 7). Le calcul des requêtes (filtre/tri/groupe/agrégation/formules) est fait **côté client** sur toutes les lignes de la base chargées en mémoire (une source partagée par toutes les vues) ; mesuré en test unitaire : filtre + double tri sur 100 000 lignes < 2 s. **Non mesuré dans l'application réelle** et chargement complet des lignes à l'ouverture : au-delà de quelques centaines de milliers de lignes, il faudra pousser filtre/tri en SQL et paginer.

### D-032 ⚠ Migration qui reconstruit une table : clés étrangères désactivées + contrôle — Acceptée
SQLite ne modifie pas un `CHECK` : `node` est reconstruit (procédure officielle en 12 étapes). Une migration marquée `-- slate:foreign_keys=off` s'exécute avec `foreign_keys=OFF` (impossible dans une transaction), puis `PRAGMA foreign_key_check` est exécuté **avant** la validation (toute violation annule la migration) ; les clés sont toujours réactivées, y compris après échec. Sans cela, `DROP TABLE node` aurait déclenché les `ON DELETE CASCADE` et effacé les contenus de pages. Testé : données v2 conservées, échec = base v2 intacte, violation détectée, sauvegarde pré-migration valide ; rejoué à blanc sur une copie de la base réelle de développement.

### D-033 Transactions imbriquables (SAVEPOINT) — Acceptée
`db::begin` remplace `unchecked_transaction` : créer une base (nœud + colonne titre + vue) est atomique, et chaque opération reste atomique quand elle est composée dans une autre.

### D-034 Positions fractionnaires : entier de 8 chiffres base 62 + fraction — Acceptée (remplace D-025 pour l'algorithme)
Le test de volume (1 500 lignes) a révélé que l'algorithme purement fractionnaire allongeait la clé d'un caractère tous les ~30 ajouts en fin de liste (> 255 caractères avant 5 000 lignes). Nouvel algorithme : ajout/préfixe = incrément/décrément de l'entier (clé de 8 caractères, 50 000 ajouts testés), insertion entre deux = entier médian ou fraction. Les anciennes clés courtes (« V », « k »…) cohabitent (lues comme leur forme complétée par des zéros).

### D-035 Conversions de type : sans perte uniquement — Acceptée
text↔longtext↔url/email/phone (vers texte), number↔percent, date→datetime, select→multiselect/status, status→select. Toute autre conversion est refusée avec un message (« créez une nouvelle propriété »). Supprimer une propriété est logique (les valeurs restent) ; retirer une option nettoie les valeurs qui l'utilisaient (action explicite).

### D-036 Relations : validation serveur + rétro-lien atomique — Acceptée
Une valeur de relation n'est acceptée que pour des lignes vivantes de la base cible et du même espace (un identifiant forgé est refusé) ; la modification de la relation et de son inverse ont lieu dans la même transaction. Non fait : rollups.

### D-037 Formules : package `@slate/formula`, évaluation côté client, jamais d'`eval` — Acceptée
Parseur Pratt + évaluateur AST, fonctions en liste blanche (table `Map`), limites (2 000 caractères, 500 nœuds, profondeur 40, textes 100 000), types stricts (pas de coercition silencieuse), évaluation paresseuse de `if` et des courts-circuits, cycles entre formules détectés, mémoïsation par objet ligne. Fuzz : 15 000 entrées aléatoires, seules des `FormulaError` sortent. Les résultats de formules ne sont pas indexés par la recherche plein texte.

### D-038 Saisie des dates en texte (AAAA-MM-JJ, JJ/MM/AAAA) — Acceptée, limite
Un `<input type="date">` natif n'accepte pas la saisie « tableur » (collage, frappe directe) ; il n'y a donc pas encore de sélecteur de calendrier (Phase 5).

### D-039 Retours d'expérience techniques
- Annulation d'une modification optimiste **cellule par cellule** (et non par instantané de tout le tableau) : deux écritures concurrentes dont l'une échoue ne s'annulent plus mutuellement (bug réel trouvé par test).
- `Enter` dans une cellule ne déclenche plus deux écritures (blur synchrone provoqué par le déplacement du focus).
- Les toasts sont masqués aux technologies d'assistance quand une boîte de dialogue modale est ouverte : les erreurs d'enregistrement d'un dialogue s'affichent donc **dans** le dialogue.

## Décisions du « Master prompt » (2026-11-07)

### D-040 Identité monochrome Slate Ω — Acceptée (remplace la palette de D-017)
Fonds : noir profond `#090909` (sombre) et blanc cassé `#F5F4F0` (clair) ; surfaces et hiérarchies en nuances neutres uniquement. Plus de bleu, violet, vert ni dégradé : l'accent est l'**encre** (noir en clair, blanc cassé en sombre, suit le thème) ou un gris (graphite, pierre, cendre) ; le sélecteur de couleur libre est supprimé. Les pastilles d'options des bases (« couleurs ») sont rendues en **niveaux de gris** (les noms stockés ne changent pas, aucune donnée migrée) ; leurs libellés deviennent « Ton 1…9 ». Seule couleur chromatique conservée : le rouge sémantique d'erreur/danger (hors décoration). Le logo est un Ω géométrique à tracé unique (`brand/`).

### D-041 Aucun projet Supabase de Slate n'existe — constat
Le compte relié au MCP Supabase contient deux projets qui ne sont **pas** ceux de Slate (« Drumo », inactif, et « CrackLess », actif). Ils ne seront ni utilisés ni modifiés. Créer un projet Slate engage un coût : il nécessite l'accord explicite de l'utilisateur (voir `docs/MASTER_PLAN.md`). Tant que ce n'est pas fait, le cloud ne peut être ni testé ni déclaré fonctionnel ; le schéma SQL et les tests RLS (pgTAP) peuvent en revanche être écrits et exécutés sur un Postgres local (Docker 26 disponible).

### D-042 Projet Supabase « Slate » créé (2026-11-07, 0 €/mois) — Acceptée (remplace le constat D-041)
Créé après accord explicite de l'utilisateur, dans l'organisation existante (plan gratuit), région Paris. Helpers d'autorisation en `SECURITY DEFINER` + `search_path` vide dans le schéma non exposé `private` ; `anon` sans droit ; chaque migration est accompagnée de tests RLS exécutés sur le projet (annulés par exception finale) et du conseiller de sécurité. Configuration et limites : `docs/SUPABASE.md`.

## Décisions — bloc productivité (2026-11-07)

### D-043 Vue calendrier générique + modèle de tâches (et non un module « tâches » séparé) — Acceptée
Un calendrier est une **vue de base** (migration 0004 : `db_view.layout` accepte `calendar`) : toute base ayant une propriété date l'affiche, déplacer une ligne modifie cette propriété. Une liste de tâches est une base créée à partir d'un modèle (`applyTaskTemplate`), donc une tâche est une ligne/page unique, identique dans toutes ses représentations, avec filtres, relations, formules et recherche déjà disponibles. Sous-tâches = relation à double sens vers la même base ; dépendances = « Bloquée par / Bloque » (information, **non appliquée** : aucune règle n'empêche encore de terminer une tâche bloquée) ; « En retard » = formule sur le *nom* de l'option « Terminé » (fragile si l'option est renommée — la formule est modifiable).
Le modèle est appliqué par appels successifs (propriétés puis vues) : une panne en cours de route laisse une base partiellement configurée, signalée par une erreur. Une création atomique côté Rust reste à faire.

### D-044 Calendrier et fuseaux horaires — Acceptée
`date` = jour civil (jamais décalé, quel que soit le fuseau) ; `datetime` = instant UTC affiché dans le jour **local** ; déplacer une date-heure conserve son heure locale (testé à travers un changement d'heure, Europe/Paris, et à Auckland/Los Angeles). Semaine commençant le lundi (réglage non configurable pour l'instant). Alternative accessible au glisser : menu « La veille / Le lendemain / La semaine suivante / Aujourd'hui ».

## Décisions — verrouillage par PIN (2026-11-07)

### D-045 ⚠ Le verrou est appliqué par le cœur natif, pas seulement par l'interface — Acceptée
`AppState.locked` : tant qu'il est actif, **toute** commande de données (`with_db`) est refusée avec l'erreur `locked` ; seules les commandes `pin_*` (`with_db_unlocked`) restent disponibles. Il est posé au démarrage si un PIN existe et que « verrouiller au démarrage » est actif, et à la demande (`pin_lock`, inactivité, Ctrl/⌘+L). L'interface n'affiche les données qu'après déverrouillage et charge les stores **après** (rien n'est demandé au cœur tant que le PIN n'est pas saisi). Un test de conception interdit à `pages_api`/`database_api` d'appeler `with_db_unlocked`.

### D-046 PIN : Argon2id, sel unique, blocage progressif persistant — Acceptée
Empreinte Argon2id (m = 19 Mio, t = 2, p = 1, sel aléatoire de 16 octets, format PHC). 5 essais libres puis blocage de 30 s doublé à chaque échec (plafond 1 h), **persisté en base** (fermer l'application ne le réinitialise pas) ; pendant le blocage, même le bon PIN est refusé. Toute vérification (déverrouiller, changer, désactiver, modifier les options) passe par la même fonction : aucun chemin ne contourne le compteur. Modifier ou désactiver exige le PIN actuel. Le PIN n'apparaît ni en base, ni dans les fichiers WAL (test), ni dans les erreurs ou logs.
Limites assumées (affichées à l'utilisateur) : ce n'est **pas un chiffrement** — le fichier SQLite n'est pas chiffré (D-009) — et un attaquant ayant accès au disque peut le lire ou supprimer la ligne de verrouillage. Le blocage progressif repose sur l'horloge système (reculer l'horloge permet de réessayer plus tôt). Les données déjà chargées restent en mémoire du WebView pendant le verrouillage (l'écran est masqué, la mémoire n'est pas purgée). Le thème de l'écran de verrouillage est celui du système (les préférences ne sont chargées qu'après déverrouillage).

## D-047 — Session de compte : refresh token seul dans le trousseau
Le refresh token (≈ 60 caractères) est le seul secret persisté, dans le trousseau OS ; le jeton d'accès reste en mémoire. Évite la limite de taille des identifiants Windows et réduit l'exposition. Le mot de passe n'est jamais conservé (champ vidé après envoi). Le PIN reste indépendant du compte.

## D-048 — Récurrence, rappels, habitudes : rôles de propriétés et tables minimales
- **Rôles** (`config.role`, liste blanche, compatibles avec le type) : `due`, `start`, `reminder` (date/date-heure), `recurrence` (sélection dont les ids `daily|weekly|monthly|yearly` sont la règle), `habit_goal` (nombre). Ils rendent les modèles reconnaissables sans table dédiée et restent valides dans une base ordinaire.
- **Récurrence** : dans `set_cells`, quand un statut passe d'un groupe non-terminé à « terminé » et que la ligne a une règle et une échéance, la ligne suivante est créée **dans la même transaction** (titre et valeurs copiés sauf statut, pourcentage, relations, calculs ; échéance et début décalés **depuis l'échéance précédente**, statut remis au premier « à faire »). Mois/années : jour ramené en fin de mois (31 janv. → 28/29 févr.). Heures date-heure conservées en UTC : **pas de recalcul des changements d'heure locaux**. Une seule occurrence est créée, même si l'échéance est très ancienne (pas de rattrapage). Redéclenchement impossible sur une tâche déjà terminée.
- **Rappels** (migration 0006, `reminder_fired`) : rappel dû = instant ≤ maintenant, tâche ni terminée ni en corbeille, non acquitté pour **cet** instant (changer l'heure le refait sonner). Interrogation au démarrage, toutes les 30 s et au retour dans la fenêtre. Notification système envoyée par une commande Rust (`tauri-plugin-notification`, MIT/Apache) : la WebView n'a **aucune** permission de plugin. **Aucun service d'arrière-plan** : application fermée, rien ne sonne ; au prochain lancement les rappels manqués (50 au plus) sont signalés une fois.
- **Habitudes** (migration 0007, `habit_log`) : seuls les pointages sont stockés ; série, taux et objectif hebdomadaire sont calculés (fonctions pures testées). Le cœur refuse dates invalides, lignes qui ne sont pas des habitudes et jours au-delà de demain (fuseaux). Le jour « aujourd'hui » est le jour **local** envoyé par l'interface.
- **Objectifs** : simple modèle de base ; la progression se saisit (pas de rollup).

## D-049 — Formatage riche : valeurs validées, pas de CSS libre
Le formatage de caractère (couleur, surlignage, police, taille) et l'interligne sont stockés comme valeurs validées (voir `features/editor/format.ts`), converties en CSS au rendu seulement. Conséquences : un contenu collé ou importé ne peut pas introduire de style arbitraire ; thèmes clair/sombre gérés par variables CSS ; migration de rendu possible sans toucher aux documents. Le lien utilise Ctrl/Cmd+Maj+K car Ctrl/Cmd+K est la palette. État détaillé : `docs/EDITOR_AUDIT.md`.

## D-050 — Images : stockage par empreinte, pas de base64, pas de SVG
Les images sont des fichiers adressés par SHA-256 dans le dossier de données (`media/`), référencés par leur seule empreinte dans le document (et donc dans l'état Yjs). Avantages : déduplication, document léger, aucune donnée binaire volumineuse dans SQLite ni dans les mises à jour collaboratives. SVG volontairement refusé (script possible). Inconvénient assumé : tant que la synchronisation n'existe pas, une image n'existe que sur l'appareil ; un document copié ailleurs afficherait « Image introuvable ». Les fichiers inutilisés ne sont pas encore purgés.

## D-051 — Versions : instantanés complets, restauration non destructive
Chaque version stocke l'état Yjs complet, le JSON et le texte (simple, restaurable sans reconstruction, au prix de l'espace : mitigé par la fréquence de 10 min et la politique de conservation). La restauration est faite par l'interface, pas par le cœur : un cœur qui remplacerait l'état Yjs enregistré divergerait de l'éditeur ouvert. Elle sauvegarde l'état courant d'abord, puis applique l'ancien contenu comme modification ordinaire. Limite : le contenu restauré est le JSON ProseMirror (la structure du document), pas l'historique Yjs interne de l'époque. La collaboration (historique par auteur) reste à faire.

## D-052 — Commentaires : l'ancrage est une marque du document, le contenu est en base
Choisir la marque (dans l'état Yjs) plutôt que des positions stockées en base garantit que l'ancrage suit le texte lors des modifications concurrentes, sans algorithme de remappage propre. Le prix : l'ancrage et le fil sont enregistrés séparément (document par l'enregistrement automatique, fil immédiatement). Une coupure entre les deux laisse au pire un fil orphelin (visible et supprimable), jamais un ancrage vers un fil inconnu qui casserait l'affichage. Le fil est créé en base AVANT la marque et retiré si la marque ne peut pas être posée.

## D-053 — Liens : liste blanche stricte, validée à chaque frontière
La validation (`link.ts`) s'applique à la saisie, au collage, au chargement du document (`isAllowedUri` du marqueur de lien) et — indépendamment — dans le cœur Rust avant l'ouverture (`external.rs`) : le WebView n'est pas digne de confiance. L'ouverture passe par une commande dédiée plutôt que par un plugin exposé au WebView (aucune permission `opener` accordée). Les liens internes utilisent un schéma propre (`slate://page/<uuid>`) distinct des mentions `@` (qui restent des nœuds) ; les deux alimentent les rétroliens.

## D-054 — Collage : la source décide de la politique par défaut
Word, Google Docs et un collage interne gardent leur mise en forme (l'utilisateur copie souvent pour conserver) ; une page web est normalisée (sa mise en forme est rarement voulue et casserait l'identité visuelle). Le menu « Coller » permet de choisir autrement à chaque fois. Détection par signatures dans le HTML du presse-papiers : heuristique, donc modifiable par l'utilisateur.

## D-055 — Mise en page des paragraphes : valeurs discrètes validées
Retraits et espacements sont des paliers fixes (niveaux de 1,5 rem, espaces prédéfinis) plutôt que des mesures libres : cohérence visuelle, rendu identique dans tous les thèmes, impossibilité d'injecter une marge arbitraire par collage, et conversion simple vers d'autres formats plus tard. L'interligne reste un attribut séparé (D-049). La progression des tâches est un décor calculé (jamais stocké) ; seul l'interrupteur l'est.

## D-056 — Synchronisation : déclencheurs SQLite, LWW par champ, contenu par journal Yjs
- **Capture par déclencheurs** (et non dans chaque fonction métier) : impossible d'oublier une écriture, et l'opération est dans la même transaction. Inactifs en invité ; `sync_settings.applying` les fait taire pendant l'application de données distantes (aucun écho).
- **Fusion par champ** avec horloge `(ms, appareil)` plutôt qu'HLC complète : plus simple, déterministe, mais sensible à la dérive d'horloge entre appareils (documenté). Le type d'un nœud ne change jamais ; les cycles sont refusés côté serveur ET ignorés côté client.
- **Contenu** : journal ajouté seul d'états Yjs complets (idempotents). Coût : volume (compaction à faire). Avantage : aucune règle de conflit à inventer, la fusion est celle de Yjs. La fusion se fait côté interface (Yjs est en TypeScript) ; l'écriture locale passe par une commande qui refuse d'écraser une page modifiée entre-temps (garde `expected_updated_at`).
- **Curseurs avec recouvrement** (50 séquences) car les séquences Postgres peuvent être validées dans le désordre ; réappliquer est sans effet.
- **« À jour »** n'est affiché qu'après accusé du serveur, file vide et aucune reprise en attente.
- Bases de données et lignes **exclues** tant que leur modèle de fusion (propriétés, relations à double sens, formules) n'est pas conçu.

## D-057 — Bases de données : fusion par cellule, configuration remplacée en bloc
Les valeurs d'une ligne se fusionnent cellule par cellule (c'est ce qui compte pour l'utilisateur : deux personnes qui remplissent deux colonnes d'une même ligne ne s'écrasent pas). Les configurations (options, filtres) sont de petits JSON remplacés en entier : fusionner leurs éléments exigerait un modèle propre à chaque type de propriété ; le coût (le plus récent gagne) est documenté. Un flux « structure » unique évite les curseurs multiples. Un conflit de nom local donne un suffixe plutôt qu'un échec, pour ne perdre aucun objet. Les identifiants automatiques ne sont pas arbitrés (à faire avec une attribution serveur).

## D-058 — Invitations par espace, jeton transmis à la main
Invitation à l'échelle de l'**espace** (pas de la page) : un seul modèle de droits, déjà appliqué par la RLS. Jeton aléatoire stocké **haché**, usage unique, expiration, lié à l'adresse du compte, erreur unique pour tous les échecs. **Pas d'e-mail** tant qu'aucun SMTP n'est configuré : le jeton est affiché une fois à l'administrateur, qui le transmet (aucun faux « e-mail envoyé »). Les invitations ne rétrogradent jamais un membre.

## D-059 — Synchronisation par espace
`sync_state` devient une ligne par espace (rôle, curseurs, erreurs) ; le moteur parcourt les espaces, rafraîchit les rôles réels depuis le serveur à chaque passage et traite chaque espace isolément (une erreur sur l'un n'arrête pas les autres, sauf réseau/session). Un lecteur garde ses opérations locales sans les envoyer ; un accès retiré arrête la synchronisation de l'espace en conservant les données. Seul l'espace personnel est créé côté serveur par le client ; un espace partagé ne s'obtient que par invitation.

## D-060 — Lecture seule : l'interface suit, le serveur décide
Le rôle `viewer` désactive l'édition et les actions de l'arbre dans l'interface, mais la garantie vient de la RLS. Les 4 fonctions `SECURITY DEFINER` des invitations sont appelables par `authenticated` volontairement : chacune vérifie elle-même l'identité et le rôle (`search_path` figé).

## D-061 — Purge par pierre tombale, compaction pilotée par le client
La purge se propage par une pierre tombale (`purged_at`) plutôt que par suppression de la ligne : sans trace, les appareils absents au moment de la purge ne l'apprendraient jamais. Le contenu est effacé, l'identifiant reste. La compaction est faite par le client car Yjs est en TypeScript (Postgres ne sait pas fusionner) ; le serveur ne supprime que la liste exacte d'identifiants fournie et vérifiée, pour qu'une mise à jour concurrente ne soit jamais perdue.

## D-062 — Commentaires : l'auteur est celui du jeton, jamais celui du client
Les fils et messages se synchronisent comme les autres entités (flux « structure », fusion par champ). L'identité de l'auteur est fixée par le serveur d'après l'adresse du jeton de session : un client modifié ne peut pas signer au nom d'un autre. Les suppressions sont logiques côté serveur (pierre tombale) pour que tous les appareils les apprennent ; les suppressions induites par la purge d'une page ne sont pas envoyées (le serveur efface les fils avec la page). Un lecteur ne commente pas : commenter écrit dans le document partagé.

## D-063 — Présence : Realtime privé en simple diffusion, état vérifié avant application
La présence passe par des canaux Realtime privés en « broadcast » (pas la présence native de Realtime, pas de changements Postgres) : l'autorisation reste dans nos politiques SQL, au même endroit que les rôles. Le direct n'est qu'une accélération de la synchronisation par journal — jamais une source de vérité. Les messages entrants sont traités comme hostiles (taille, forme, état jetable, pas de réécriture de soi). Les curseurs sont monochromes, repérés par le nom. Dépendance directe ajoutée : `y-protocols` (MIT, déjà installée en transitif par `@tiptap/y-tiptap`).

## D-064 — E-mail d'invitation : le serveur choisit le destinataire, le fournisseur est un détail
Une fonction Edge envoie le message, mais le destinataire est lu dans l'invitation côté base (jamais fourni par l'appelant) après vérification du rôle d'administrateur ; elle utilise le jeton de l'appelant, pas de `service_role`. Réservation d'envoi atomique avec plafonds (3 par invitation, 1 par minute), rendue en cas d'échec. Les secrets (clé du fournisseur, expéditeur) vivent côté Supabase, jamais dans le dépôt. L'interface n'affirme « remis au service d'envoi » que sur confirmation du serveur, et affiche toujours le jeton : l'e-mail est un confort, jamais une dépendance.

## D-065 — Partage d'un élément : accès décidé par nœud, l'invité n'est pas membre
Un partage ciblé ne crée pas de membre : il crée un droit sur un nœud (`node_shares`) qui s'étend aux descendants. Toutes les règles de sécurité passent par `private.node_access`, la seule fonction qui décide (rôle de membre OU partage sur le nœud ou un ancêtre). Un invité ne peut ni déplacer/supprimer l'élément partagé, ni écrire hors du partage, ni purger ; le parent d'un élément partagé lui est masqué. Rôles d'invité : lecteur ou éditeur, jamais administrateur.

## D-066 — Mises à jour : signées, sur clic, par GitHub Releases
Le module officiel Tauri vérifie la signature de chaque archive avec une clé publique embarquée. Aucune installation sans clic. La clé privée reste hors du dépôt (secret GitHub). Hébergement : `latest.json` joint à la dernière release publiée. Compromis connu : si la clé privée est perdue, les installations existantes ne pourront plus être mises à jour (il faudra réinstaller à la main).

## D-067 — Onglets : un historique par onglet, clic = remplace, Ctrl/⌘+clic = nouvel onglet
Comme dans Obsidian : cliquer une page la montre dans l'onglet actif ; Ctrl/⌘+clic, clic du milieu ou « Ouvrir dans un nouvel onglet » l'ouvre à droite. Une page déjà ouverte dans un onglet y ramène au lieu d'en créer un second. Chaque onglet a son propre historique (précédent/suivant). Le dernier onglet ne disparaît jamais (retour à l'accueil) ; 30 onglets au plus ; les 10 derniers fermés se rouvrent. Seule la route de chaque onglet est enregistrée (jamais de contenu), validée à la relecture. **Fermer l'onglet = Ctrl/⌘+Alt+W** et non ⌘+W : sur macOS le menu natif réserve ⌘+W à la fermeture de la fenêtre, avant que l'application ne voie la touche. La barre est une barre de navigation de boutons (et non un `tablist` ARIA) pour que chaque onglet ait son bouton de fermeture accessible sans imbrication interactive.
