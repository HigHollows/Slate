# Slate — Modèle de données (initial, v0)

> Proposition Phase 0. Le DDL exact sera écrit en migrations en Phases 1/3/4/7. Tout changement passe par une migration versionnée.

## 1. Conventions communes

- Clés primaires : **UUID v7** (texte en SQLite, `uuid` en Postgres), générés côté client.
- Colonnes de synchronisation sur toutes les entités synchronisées :
  `created_at`, `updated_at` (UTC ISO-8601), `deleted_at` (NULL = vivant ; **tombstone**), `deleted_by`,
  `version` (compteur local), `field_clocks` (JSON : HLC par champ, pour la fusion champ par champ), `server_seq` (rempli au pull, NULL tant que non confirmé).
- Suppression logique par défaut (corbeille). Purge définitive = opération explicite, journalisée.
- Ordre : colonne `position` en **texte fractionnaire** (fractional indexing).
- Clés étrangères actives (`PRAGMA foreign_keys=ON`) ; `ON DELETE` volontairement `RESTRICT` pour les objets métier (la suppression passe par tombstone).
- JSON : colonnes `TEXT` validées côté Rust (schémas Zod/serde) ; `json_extract` + colonnes générées indexées si besoin.

## 2. Tables SQLite — noyau (Phase 1/3)

```
_migrations(version PK, name, checksum, applied_at)
device(id PK, name, created_at)                        -- identité de l'appareil (device_id)
settings(key PK, scope, value_json, updated_at, clock) -- préférences, profils de configuration

workspace(id, name, kind CHECK(kind IN ('personal','shared')), icon, owner_id NULL, ...sync)
node(                                                   -- arbre unifié : dossier | page | base | dashboard | raccourci | fichier
  id, workspace_id FK, parent_id FK NULL, kind, title, icon, cover,
  position, is_favorite, pinned, target_id NULL,        -- target_id pour les raccourcis (lien vers un autre node)
  ...sync)
INDEX node(workspace_id, parent_id, position) WHERE deleted_at IS NULL

page_content(node_id PK FK, doc_state BLOB, content_json TEXT, schema_version, text_plain, updated_at)
page_version(id, node_id FK, created_at, author_id NULL, reason, snapshot_json, doc_state BLOB)  -- historique/restauration

link(id, source_type, source_id, target_type, target_id, kind CHECK(kind IN ('mention','internal','relation')), ...)
INDEX link(target_type, target_id)                      -- backlinks
recent(node_id, opened_at) ; nav_history(...)

search_index  -- FTS5 : kind, entity_id, workspace_id, title, body, updated_at (contentless + table de correspondance)
```

Un `node` dans le workspace A peut être la cible d'un `link` depuis le workspace B si les permissions le permettent (vérifié à la lecture/serveur).

## 3. Bases de données (Phase 4)

```
db_schema(node_id PK FK -> node, kind CHECK(kind IN ('user','system_tasks','system_events',...)), ...sync)
property(id, db_id FK, name, type, config_json, position, is_hidden, ...sync)       -- type ∈ registre extensible
row(id, db_id FK, node_id FK NULL, title, props_json, created_by, ...sync)           -- une ligne = optionnellement une page complète
INDEX row(db_id, updated_at) WHERE deleted_at IS NULL
row_value_index(row_id, property_id, text_val, num_val, date_val)                    -- index dérivé pour tri/filtre rapides
view(id, db_id FK, name, layout CHECK(layout IN ('table','kanban','calendar','gallery','list')),
     config_json /* filtres, tris, groupes, colonnes visibles/largeurs/ordre */, position, ...sync)
relation(id, from_row_id, property_id, to_row_id, ...sync)   -- relations entre lignes (bidirectionnelles via 2 propriétés liées)
formula_cache(row_id, property_id, value_json, deps_hash)
```

- `props_json` : `{ "<property_id>": <valeur typée> }` ; chaque type de propriété valide/normalise sa valeur.
- Les types sélection/statut référencent des `option_id` stables (renommer ≠ casser les données).
- Propriétés calculées (création, dernière modification, ID auto, formules, rollups) **non stockées** ou stockées en cache invalidable.

## 4. Productivité (Phase 5)

Les **tâches ne sont pas une table séparée** : ce sont des `row` d'une `db_schema.kind='system_tasks'` avec propriétés standard :
`status, priority, start, due, assignees(person[]), project(relation), parent(relation→tâche), depends_on(relation[]), recurrence_rule(RRULE), reminders, progress, linked_pages`.

```
time_entry(id, task_row_id FK, started_at, ended_at NULL, note, user_id, ...sync)
event(id, calendar_id, title, starts_at, ends_at, all_day, tz, rrule NULL, ...sync)   -- ou ligne d'une base 'system_events'
goal(id, parent_goal_id NULL, title, target_json, period, ...sync)  + goal_link(goal_id, entity_type, entity_id)
habit(id, title, frequency_json, ...sync) ; habit_log(id, habit_id, date, value, ...sync)   -- séries calculées, non stockées
reminder(id, entity_type, entity_id, fire_at, channel, fired_at NULL, ...)
dashboard(node_id FK) ; widget(id, dashboard_id, type, config_json, layout_json{x,y,w,h}, ...sync)
automation(id, workspace_id, name, enabled, trigger_json, conditions_json, actions_json, runs_on, created_by, ...sync)
automation_run(id, automation_id, event_key UNIQUE, status, steps_json, error, started_at, finished_at)   -- idempotence via event_key
template(id, kind, name, category, payload_json, parent_template_id NULL, ...sync)
```

## 5. Fichiers, sync, sécurité locale

```
file(id, workspace_id, node_id NULL, name, mime, size, sha256, local_path NULL, remote_path NULL,
     upload_state, folder_id NULL, meta_json, ...sync)           -- contenu immuable adressé par hash
file_text(file_id PK, text, extracted_at)                          -- texte PDF indexé
file_link(file_id, entity_type, entity_id)                        -- association → hérite des permissions de l'entité

oplog(op_id PK, entity, entity_id, kind, fields_json, hlc, base_version, device_id,
      status CHECK(status IN ('pending','sent','acked','rejected')), attempts, last_error, created_at)
sync_state(scope PK, cursor, last_pull_at, last_push_at)           -- curseur server_seq par espace
sync_conflict(id, entity, entity_id, local_json, remote_json, detected_at, resolved_at NULL, resolution)
migration_job(id, kind, state, progress_json, started_at, updated_at)   -- migration invité→compte, import Notion…
backup_log(id, created_at, path, sha256, kind, verified_at NULL)
security_local(id=1, pin_hash, pin_salt, pin_params, failed_count, locked_until, lock_on_start, idle_minutes)
audit_local(id, at, action, entity, entity_id, meta_json)        -- opérations sensibles (suppression définitive, restauration, export…)
```

## 6. Documents collaboratifs (cloud, Phase 8)

Localement : `page_content.doc_state` (Yjs). Côté Postgres :
```
doc_update(id bigserial, node_id, author_id, update bytea, created_at)        -- append-only, RLS
doc_snapshot(node_id, up_to_update_id, state bytea, created_at)               -- compactage
```

## 7. Modèle cloud (Postgres, Phase 7) — esquisse

Mêmes tables métier que SQLite (préfixées par `workspace_id` pour RLS), plus :
```
profile(user_id PK -> auth.users, display_name, avatar_path)
workspace_member(workspace_id, user_id, role CHECK(role IN ('viewer','editor','admin')), PRIMARY KEY(...))
node_permission(node_id, user_id, role)           -- surcharges par page (peuvent restreindre ou élargir selon règle documentée)
invitation(id, workspace_id, email, role, token_hash, expires_at, accepted_at, invited_by)
applied_op(op_id PK, workspace_id, applied_at, result)         -- idempotence
change_feed : colonne server_seq (identity) sur chaque table synchronisée + index (workspace_id, server_seq)
comment(id, node_id, anchor_json, author_id, body, resolved_at, ...)
audit_log(id, at, actor_id, action, entity, entity_id, meta)   -- append-only, écriture serveur
```
Le détail RLS (fonctions `is_member(ws, min_role)`, `can_access_node(node)`) est dans `SECURITY.md`.

## 8. Index et performance (principes)

Chaque requête de liste critique a un index couvrant (cf. index partiels `WHERE deleted_at IS NULL`). Pagination par curseur (`(position,id)` ou `(updated_at,id)`), jamais `OFFSET` profond. `EXPLAIN QUERY PLAN` vérifié par tests pour les requêtes clés.

## 9. Points ouverts (à trancher avant les migrations correspondantes)

1. `row.props_json` vs table EAV `cell` : JSON retenu pour la simplicité et la sync par champ ; revalider avec benchmarks Phase 4 (100 k lignes).
2. Calendrier/événements : table dédiée ou base système ? Penchant : base système `system_events` pour cohérence.
3. Sémantique exacte des permissions de page vs espace (héritage, surcharge restrictive) — à figer avant Phase 8.

## 10. État réel après la Phase 3 (migration `0002_pages.sql`)

Implémenté : `workspace`, `node` (dossiers/pages, `position` fractionnaire, `is_favorite`, suppression logique `deleted_at`, `version`), `page_content` (`doc_state` Yjs, `content_json`, `text_plain`, `schema_version`), `link` (mentions), `recent`, `search_index` (FTS5 `unicode61 remove_diacritics 2`).
Écarts avec l'esquisse initiale : pas de colonne `pinned` (épingles non faites), pas de `page_version` (historique : Phase 10), `field_clocks`/`server_seq` et `target_id` (raccourcis) arrivent avec la synchronisation et les raccourcis ; les kinds `database`/`dashboard`/`shortcut` seront ajoutés par migration (le `CHECK` actuel n'accepte que `folder` et `page`).
Contraintes vérifiées par tests : pas de cycle, profondeur ≤ 32, titre ≤ 500 car., ordre stable, FK `RESTRICT` (jamais d'orphelin), purge uniquement depuis la corbeille.

## 11. État réel après la Phase 4 (migration `0003_databases.sql`)

`node.kind` accepte désormais `database`. Nouvelles tables : `db_property` (type parmi 19, `config_json`, `position`, suppression logique, nom unique insensible à la casse par base, une seule propriété titre), `db_row` (`node_id` → `node`, `database_id`, `props_json`), `db_view` (layout `table|kanban|list|gallery`, `config_json` ≤ 64 Ko), `db_meta` (compteur des identifiants automatiques, jamais réutilisés).
Types **implémentés** : title, text, longtext, number, percent, date, datetime, checkbox, select, multiselect, status, url, email, phone, relation (double sens), formula, id, created_time, last_edited_time. **Non implémentés** : person (nécessite des comptes), file (Phase 9), rollup.
Configuration de vue (JSON, lue de façon tolérante) : `filter` (groupes ET/OU imbriqués), `sorts`, `groupBy`, `hidden`, `widths`, `aggregations`, `cardSize`, `wrap` (réservé, inutilisé).
Valeurs : texte/URL/e-mail/téléphone = chaîne ; nombre/pourcentage = nombre fini ; date = `AAAA-MM-JJ` ; date-heure = `AAAA-MM-JJTHH:MM:SSZ` (UTC) ; case = booléen ; sélection/statut = identifiant d'option ; multi = liste d'identifiants ; relation = liste d'identifiants de lignes. Toutes validées dans `database.rs` avant écriture.
