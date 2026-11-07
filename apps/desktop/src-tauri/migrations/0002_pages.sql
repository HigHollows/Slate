-- 0002 : espaces, arbre de contenus (dossiers/pages), contenu des pages, liens, récents, recherche plein texte.
-- Voir DATA_MODEL.md. Les colonnes de synchronisation (field_clocks, server_seq) arriveront avec la Phase 7.

CREATE TABLE workspace (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind        TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'shared')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE node (
  id            TEXT PRIMARY KEY NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  parent_id     TEXT REFERENCES node(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('folder', 'page')),
  title         TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  position      TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 255),
  is_favorite   INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE INDEX node_tree ON node (workspace_id, parent_id, position) WHERE deleted_at IS NULL;
CREATE INDEX node_favorite ON node (workspace_id) WHERE is_favorite = 1 AND deleted_at IS NULL;
CREATE INDEX node_trashed ON node (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX node_children ON node (parent_id);

-- Contenu d'une page : état Yjs (source de vérité éditable) + instantané ProseMirror JSON dérivé + texte brut (recherche).
CREATE TABLE page_content (
  node_id         TEXT PRIMARY KEY NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  doc_state       BLOB NOT NULL,
  content_json    TEXT NOT NULL CHECK (json_valid(content_json)),
  text_plain      TEXT NOT NULL DEFAULT '',
  schema_version  INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL
) STRICT;

-- Liens internes (mentions de pages) : backlinks par simple requête indexée.
CREATE TABLE link (
  source_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'mention' CHECK (kind IN ('mention')),
  PRIMARY KEY (source_id, target_id, kind)
) STRICT, WITHOUT ROWID;
CREATE INDEX link_target ON link (target_id);

CREATE TABLE recent (
  node_id    TEXT PRIMARY KEY NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  opened_at  TEXT NOT NULL
) STRICT;
CREATE INDEX recent_opened ON recent (opened_at DESC);

-- Recherche plein texte hors ligne, insensible à la casse et aux accents.
CREATE VIRTUAL TABLE search_index USING fts5 (
  node_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
