# Synchronisation — première tranche (arborescence + contenu des pages)

## Périmètre
**Synchronisé** : espaces (création côté cloud), arborescence de dossiers, pages et bases (titre, parent, position, type, corbeille), contenu des pages (état Yjs), **bases de données : propriétés, vues et valeurs des lignes (par cellule)**. **Pas encore** : commentaires, versions, images, préférences, favoris (par utilisateur), habitudes, rappels, compteur d'identifiants automatiques. L'interface le dit.

## Principes (voir ARCHITECTURE §8)
- Écriture locale = transaction SQLite ; des **déclencheurs** inscrivent l'opération dans `oplog` dans la **même transaction** (aucune écriture synchronisable sans opération). Inactifs tant que la synchronisation n'est pas activée (mode invité : aucune file ne grossit).
- **Activer** la synchronisation = remplir `oplog` avec tout l'existant (migration invité → compte pour ces données) puis pousser par lots idempotents.
- **Push** : RPC `sync_push` (SECURITY INVOKER : RLS appliquée), idempotence par `op_id`, fusion **par champ** (LWW sur l'horloge `(ms, appareil)`), détection de cycles, refus motivé. **Pull** : curseurs serveur (`nodes.server_seq`, `doc_updates.id`) avec **fenêtre de recouvrement** (les séquences Postgres peuvent être validées dans le désordre ; réappliquer est sans effet).
- **Contenu** : suite de mises à jour Yjs **ajoutées** (jamais modifiées) ; chaque client applique celles des autres (fusion CRDT dans l'application, car la fusion Yjs vit en TypeScript), recalcule JSON/texte puis écrit localement **sans** recréer d'opération.
- Un champ modifié localement et non encore acquitté n'est **jamais** écrasé par un pull.
- Le statut « à jour » n'apparaît qu'après accusé du serveur ET file vide.

## Limites connues (à tenir à jour)
- Horloges des appareils non synchronisées : LWW par champ peut départager à tort deux modifications très proches venant d'appareils dont l'heure diverge (pas d'HLC complète).
- Chaque envoi de contenu contient l'état complet de la page (idempotent mais volumineux) : compaction et envoi différentiel à faire.
- Pas de collaboration temps réel (présence, curseurs) : le transport Realtime n'est pas branché ; la synchronisation est périodique.
- Suppression définitive (purge) non propagée.
- Pas de chiffrement de bout en bout.

## État réel (fin de la première tranche)
**Fait et testé**
- Serveur (migration `20261107000002_sync.sql`, appliquée au projet Slate) : `nodes.server_seq` + `clocks`, `applied_ops`, `doc_updates` (ajout seul), RPC `sync_push` / `sync_pull` (SECURITY INVOKER). **36 assertions SQL exécutées sur le vrai projet** (`supabase/tests/sync.sql`, tout annulé à la fin) : création dans l'ordre, idempotence, dernière écriture par champ (ancienne ignorée, récente appliquée, égalité départagée par appareil, champs indépendants fusionnés), tombstone / restauration, refus motivés (parent inconnu, cycle, nœud d'un autre espace, création incomplète, type immuable), un refus n'arrête pas le lot, contenu ajouté / idempotent / refusé pour un dossier, pull par curseurs et pagination, droits (non-membre, lecteur, anonyme). Conseiller de sécurité Supabase : 0 alerte.
- Local (migration 0010) : file `oplog` alimentée par déclencheurs dans la même transaction (inactifs en mode invité), activation = inscription de tout l'existant (parents d'abord, sans bases ni lignes), accusés (appliqué / temporaire réessayé 20 fois / permanent conservé), application des nœuds distants (ordre rétabli, champ local en attente jamais écrasé, cycles refusés, parent inconnu = curseur bloqué), contenu distant avec garde de fraîcheur, aucun écho. 10 tests Rust.
- Interface : client HTTP (5 tests), moteur (14 tests : lots, curseurs avec recouvrement, fusion Yjs réelle sans perte, pages ouvertes mises à jour en direct, reprises, erreurs classées, un seul passage à la fois), section « Synchronisation » du compte (5 tests dont « À jour » seulement après l'accusé du serveur).

**Non vérifié (honnêtement)**
- ~~Aucun essai de bout en bout~~ **Fait le 2026-11-07 (premier envoi réel)** : compte réel, activation depuis l'application, 27 opérations appliquées par le serveur (23 nœuds dont 8 en corbeille, 4 contenus), 0 refusée, file locale vide, curseur de nœuds = dernière séquence serveur, contenus identiques octet pour octet (taille et md5 comparés des deux côtés). Éprouvé : jeton, création de l'espace, `sync_push`, accusés. **Pas encore éprouvé en réel** : la réception (`sync_pull` appliqué depuis un autre appareil) et la convergence de deux appareils.
- Deux appareils réels qui convergent : seulement par les tests des deux moitiés (et le premier envoi réel ci-dessus), pas ensemble.
- Taille et performances sur de gros espaces ; coupure en plein lot ; fuseaux/horloges très décalés.
- Un nœud dont le parent n'arrive jamais bloque le curseur (visible comme « en reprise », jamais comme « à jour »).

## Bases de données (deuxième tranche)
- **Modèle** : une base est un nœud `database` ; ses lignes sont des nœuds enfants (arborescence) + une entrée `db_rows` (valeurs). Propriétés (`db_properties`) et vues (`db_views`) ont leur table. Même séquence `sync_seq` que les nœuds, **un seul flux « structure »** (`sync_pull_struct`, un curseur, pagination exacte).
- **Fusion** : propriétés et vues = dernière écriture **par champ** (nom, type/mise en page, configuration entière, position, corbeille) ; lignes = dernière écriture **par cellule** (chaque cellule a sa propre horloge ; vider une cellule est une écriture qui ne ressuscite pas avec une écriture plus ancienne). Une configuration (options d'un statut, filtres d'une vue) est remplacée **en entier** : deux appareils qui modifient la même configuration en même temps ne fusionnent pas ses éléments (le plus récent gagne).
- **Local** : déclencheurs sur `db_property`, `db_view`, `db_row` (une opération par cellule modifiée, ajoutée ou retirée). Les relations à double sens sont des listes dans les deux lignes : chaque côté se synchronise comme une cellule ordinaire.
- **Application distante** : chaque élément dans son point de sauvegarde ; une cellule ou un champ modifié localement et pas encore acquitté n'est jamais écrasé ; un nom de propriété déjà pris localement (même à la casse près) donne « nom (2) » plutôt qu'une perte ; un second champ « titre » est compté comme ignoré (visible) ; un élément dont la base ou le nœud de la ligne n'est pas encore arrivé bloque le curseur (reprise).
- **Rattrapage** : une synchronisation activée avant cette tranche inscrit automatiquement, une seule fois, les bases existantes à la passe suivante (testé ; observé sur la vraie base).
- **Vérifié** : 34 assertions SQL sur le vrai projet (`supabase/tests/sync_databases.sql`) ; 11 tests Rust de plus ; 5 tests du moteur ; **réel** : les 2 bases, 2 propriétés et 2 vues de cette installation sont arrivées sur le serveur (0 refusée). **Pas encore éprouvé en réel** : des lignes avec valeurs (cette installation n'en a pas), la réception depuis un second appareil.
- **Limites** : les valeurs « ID automatique » sont attribuées localement (collisions possibles entre appareils, jamais corrigées pour l'instant) ; le compteur `db_meta` n'est pas synchronisé ; une ligne dont le nœud arrive avant ses valeurs apparaît brièvement comme page simple ; pas de purge propagée.

## Espaces partagés (troisième tranche)
La synchronisation est **par espace** : curseurs, rôle et erreurs par espace dans `sync_state`. Le moteur rafraîchit les rôles réels à chaque passage, regroupe les opérations par espace, n'envoie rien pour un espace en lecture seule et arrête (en conservant les données) un espace dont l'accès a été retiré. Invitations : voir `docs/COLLABORATION.md`.

## Suppression définitive et compaction (quatrième tranche)
- **Purge propagée.** Purger localement (corbeille) émet, par nœud supprimé (enfants avant parents), une opération `purged_at` qui porte l'espace (le nœud n'existe plus pour le retrouver). Le serveur n'accepte que depuis la corbeille (rôle éditeur), efface le contenu (journal Yjs, propriétés, vues, lignes), vide le titre et **garde une pierre tombale** (`nodes.purged_at`) : les autres appareils la reçoivent par le flux des nœuds et suppriment leur copie (les enfants non purgés remontent à la racine ; les opérations locales en attente sur ce nœud sont abandonnées ; aucun écho). Un nœud purgé ne ressuscite pas et n'accepte plus de contenu. Limite : la pierre tombale (identifiant, type, dates) reste sur le serveur.
- **Compaction.** Le journal Yjs ne fait que grossir. Un client éditeur relit toutes les mises à jour d'une page (≥ 100, au plus une passe toutes les 10 minutes par espace), les fusionne et demande au serveur de remplacer **cette liste exacte** d'identifiants par l'état fusionné (`sync_compact_doc`, seule fonction qui supprime des lignes du journal, `SECURITY DEFINER`, rôle vérifié, refusée si un identifiant est inconnu). Une mise à jour arrivée entre-temps n'est donc jamais supprimée. Un échec est sans conséquence. Non fait : compaction automatique côté serveur, instantanés de pages.

## Commentaires partagés (cinquième tranche)
- **Ce qui est synchronisé** : fils (`thread` : page, extrait, résolution) et messages (`comment` : texte), dans le flux « structure » existant. L'ancrage dans le texte est une marque du document : il voyage déjà avec le contenu de la page.
- **Auteur** : jamais fourni par le client. Le serveur inscrit l'adresse du jeton (`author_label`, `resolved_label`) ; un client ne peut pas se faire passer pour un autre. Côté interface, modifier/supprimer le message ou le fil d'un autre est masqué sauf pour un administrateur ; le serveur refuse de toute façon (modification : auteur ou administrateur ; suppression de fil : créateur ou administrateur).
- **Fusion** : champ par champ, plus récent gagne (texte d'un message, résolution, suppression). Une modification locale en attente n'est jamais écrasée. Suppression distante = suppression locale (sans écho). Un message arrive toujours après son fil dans le flux (toute modification d'un fil « touche » ses messages) ; sinon la reprise attend sans avancer le curseur.
- **Droits** : écriture réservée aux éditeurs et administrateurs. **Un lecteur ne peut pas commenter.**
- **Purge** : purger une page efface ses fils et messages sur le serveur ; les copies locales partent avec la page.
- **Limites** : les surlignages d'un fil supprimé ailleurs restent dans le document tant que la marque n'est pas retirée ; pas de notifications ni de mentions ; pas de résolution « par utilisateur ».
