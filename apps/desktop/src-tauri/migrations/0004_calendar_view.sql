-- slate:foreign_keys=off
-- 0004 : la vue « calendrier » devient un type de vue valide (le CHECK de db_view est reconstruit).
CREATE TABLE db_view_new (
  id           TEXT PRIMARY KEY NOT NULL,
  database_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  layout       TEXT NOT NULL CHECK (layout IN ('table', 'kanban', 'list', 'gallery', 'calendar')),
  config_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND length(config_json) <= 65536),
  position     TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 255),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
) STRICT;
INSERT INTO db_view_new (id, database_id, name, layout, config_json, position, created_at, updated_at, deleted_at, version)
  SELECT id, database_id, name, layout, config_json, position, created_at, updated_at, deleted_at, version FROM db_view;
DROP TABLE db_view;
ALTER TABLE db_view_new RENAME TO db_view;
CREATE INDEX db_view_order ON db_view (database_id, position) WHERE deleted_at IS NULL;
