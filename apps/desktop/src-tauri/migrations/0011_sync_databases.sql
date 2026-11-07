-- 0011 : synchronisation des bases de données (propriétés, vues, lignes par cellule). Voir docs/SYNC.md.
-- `oplog.entity` doit accepter les nouvelles entités : SQLite ne modifie pas un CHECK, on reconstruit la table (même contenu,
-- mêmes valeurs par défaut : les déclencheurs de 0010 en dépendent).
-- Les déclencheurs de 0010 écrivent dans `oplog` : on les retire le temps de la reconstruction, puis on les recrée à l'identique.
DROP TRIGGER sync_node_insert;
DROP TRIGGER sync_node_title;
DROP TRIGGER sync_node_parent;
DROP TRIGGER sync_node_position;
DROP TRIGGER sync_node_deleted;
DROP TRIGGER sync_doc_insert;
DROP TRIGGER sync_doc_update;

CREATE TABLE oplog_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id      TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  entity     TEXT NOT NULL CHECK (entity IN ('node', 'doc', 'prop', 'view', 'row')),
  entity_id  TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields_json)),
  clock_ms   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
INSERT INTO oplog_new (seq, op_id, entity, entity_id, fields_json, clock_ms, status, attempts, last_error, created_at)
  SELECT seq, op_id, entity, entity_id, fields_json, clock_ms, status, attempts, last_error, created_at FROM oplog;
DROP TABLE oplog;
ALTER TABLE oplog_new RENAME TO oplog;
CREATE INDEX oplog_pending ON oplog (status, seq);
CREATE INDEX oplog_entity ON oplog (entity, entity_id, status);

-- Déclencheurs de 0010, recréés à l'identique.
CREATE TRIGGER sync_node_insert AFTER INSERT ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id = (SELECT workspace_id FROM sync_settings WHERE id = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id,
          json_object('kind', NEW.kind, 'title', NEW.title, 'parent_id', NEW.parent_id, 'position', NEW.position, 'deleted_at', NEW.deleted_at),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_node_title AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.title IS NOT OLD.title
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('title', NEW.title), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_node_parent AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.parent_id IS NOT OLD.parent_id
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('parent_id', NEW.parent_id), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_node_position AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_node_deleted AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_doc_insert AFTER INSERT ON page_content
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0
 AND (SELECT workspace_id FROM node WHERE id = NEW.node_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1)
BEGIN
  DELETE FROM oplog WHERE entity = 'doc' AND entity_id = NEW.node_id AND status = 'pending';
  INSERT INTO oplog (entity, entity_id, clock_ms) VALUES ('doc', NEW.node_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_doc_update AFTER UPDATE OF doc_state ON page_content
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0
 AND NEW.doc_state IS NOT OLD.doc_state
 AND (SELECT workspace_id FROM node WHERE id = NEW.node_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1)
BEGIN
  DELETE FROM oplog WHERE entity = 'doc' AND entity_id = NEW.node_id AND status = 'pending';
  INSERT INTO oplog (entity, entity_id, clock_ms) VALUES ('doc', NEW.node_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

ALTER TABLE sync_state ADD COLUMN struct_cursor INTEGER NOT NULL DEFAULT 0;
-- 0 = les bases existantes ne sont pas encore inscrites dans la file (fait à la prochaine passe, voir sync.rs).
ALTER TABLE sync_state ADD COLUMN struct_backfilled INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER sync_prop_insert AFTER INSERT ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name, 'type', NEW.type,
          'config', json(NEW.config_json), 'position', NEW.position, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_prop_name AFTER UPDATE OF name ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.name IS NOT OLD.name
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_prop_type AFTER UPDATE OF type ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.type IS NOT OLD.type
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'type', NEW.type), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_prop_config AFTER UPDATE OF config_json ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.config_json IS NOT OLD.config_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'config', json(NEW.config_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_prop_position AFTER UPDATE OF position ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_prop_deleted AFTER UPDATE OF deleted_at ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_insert AFTER INSERT ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name, 'layout', NEW.layout,
          'config', json(NEW.config_json), 'position', NEW.position, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_view_name AFTER UPDATE OF name ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.name IS NOT OLD.name
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_view_layout AFTER UPDATE OF layout ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.layout IS NOT OLD.layout
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'layout', NEW.layout), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_view_config AFTER UPDATE OF config_json ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.config_json IS NOT OLD.config_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'config', json(NEW.config_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_view_position AFTER UPDATE OF position ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_view_deleted AFTER UPDATE OF deleted_at ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- Lignes : une opération par cellule modifiée (ajoutée, changée ou retirée = null).
CREATE TRIGGER sync_row_insert AFTER INSERT ON db_row
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('row', NEW.node_id, json_object('database_id', NEW.database_id, 'cells', json(NEW.props_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER sync_row_cells AFTER UPDATE OF props_json ON db_row
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) = (SELECT workspace_id FROM sync_settings WHERE id = 1) AND NEW.props_json IS NOT OLD.props_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  SELECT 'row', NEW.node_id,
         json_object('database_id', NEW.database_id, 'cells', json_object(j.key, json(NEW.props_json -> ('$."' || j.key || '"')))),
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  FROM json_each(NEW.props_json) j
  WHERE (OLD.props_json -> ('$."' || j.key || '"')) IS NOT (NEW.props_json -> ('$."' || j.key || '"'));
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  SELECT 'row', NEW.node_id,
         json_object('database_id', NEW.database_id, 'cells', json_object(o.key, json('null'))),
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  FROM json_each(OLD.props_json) o
  WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.props_json) n WHERE n.key = o.key);
END;
