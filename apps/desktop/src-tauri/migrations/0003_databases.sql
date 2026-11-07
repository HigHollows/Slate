-- slate:foreign_keys=off
-- 0003 : bases de données (propriétés, lignes, vues).
-- Reconstruction de `node` pour accepter le type 'database' (SQLite ne sait pas modifier un CHECK).
-- Les clés étrangères sont désactivées par le moteur de migrations pendant cette migration (étapes officielles
-- « 12-step ALTER TABLE ») : sans cela, DROP TABLE déclencherait les ON DELETE CASCADE et effacerait page_content.
-- Le moteur exécute `PRAGMA foreign_key_check` avant validation : toute violation annule la migration.

CREATE TABLE node_new (
  id            TEXT PRIMARY KEY NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  parent_id     TEXT REFERENCES node(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('folder', 'page', 'database')),
  title         TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  position      TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 255),
  is_favorite   INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

INSERT INTO node_new (id, workspace_id, parent_id, kind, title, position, is_favorite, created_at, updated_at, deleted_at, version)
  SELECT id, workspace_id, parent_id, kind, title, position, is_favorite, created_at, updated_at, deleted_at, version FROM node;

DROP TABLE node;
ALTER TABLE node_new RENAME TO node;

CREATE INDEX node_tree ON node (workspace_id, parent_id, position) WHERE deleted_at IS NULL;
CREATE INDEX node_favorite ON node (workspace_id) WHERE is_favorite = 1 AND deleted_at IS NULL;
CREATE INDEX node_trashed ON node (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX node_children ON node (parent_id);

-- Propriétés (colonnes). La propriété « titre » est stockée dans node.title des lignes ; elle porte le nom de la colonne.
CREATE TABLE db_property (
  id           TEXT PRIMARY KEY NOT NULL,
  database_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type         TEXT NOT NULL CHECK (type IN (
                 'title','text','longtext','number','percent','date','datetime','checkbox',
                 'select','multiselect','status','url','email','phone','relation','formula',
                 'id','created_time','last_edited_time')),
  config_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  position     TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 255),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX db_property_name ON db_property (database_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX db_property_title ON db_property (database_id) WHERE type = 'title' AND deleted_at IS NULL;
CREATE INDEX db_property_order ON db_property (database_id, position) WHERE deleted_at IS NULL;

-- Lignes : chaque ligne est AUSSI un nœud (page) enfant de la base => ouverture en page complète, recherche,
-- mentions, corbeille et restauration réutilisent l'existant. Valeurs : { "<id propriété>": valeur } (hors titre).
CREATE TABLE db_row (
  node_id      TEXT PRIMARY KEY NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  database_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  props_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props_json))
) STRICT;
CREATE INDEX db_row_database ON db_row (database_id);

CREATE TABLE db_view (
  id           TEXT PRIMARY KEY NOT NULL,
  database_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  layout       TEXT NOT NULL CHECK (layout IN ('table', 'kanban', 'list', 'gallery')),
  config_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND length(config_json) <= 65536),
  position     TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 255),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX db_view_order ON db_view (database_id, position) WHERE deleted_at IS NULL;

CREATE TABLE db_meta (
  database_id   TEXT PRIMARY KEY NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  next_auto_id  INTEGER NOT NULL DEFAULT 1
) STRICT;
