-- 0012 : synchronisation de PLUSIEURS espaces (le vôtre + ceux auxquels vous êtes invité). Voir docs/COLLABORATION.md.
-- `sync_state` devient la table par espace : état (activé ou non), rôle sur le serveur, curseurs.
-- Les déclencheurs ne regardaient qu'UN espace (`sync_settings.workspace_id`) : on les recrée pour « tout espace activé ».
ALTER TABLE sync_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1));
ALTER TABLE sync_state ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('viewer', 'editor', 'admin'));
UPDATE sync_state SET enabled = 1
  WHERE workspace_id = (SELECT workspace_id FROM sync_settings WHERE id = 1 AND enabled = 1);

DROP TRIGGER sync_node_insert;
DROP TRIGGER sync_node_title;
DROP TRIGGER sync_node_parent;
DROP TRIGGER sync_node_position;
DROP TRIGGER sync_node_deleted;
DROP TRIGGER sync_doc_insert;
DROP TRIGGER sync_doc_update;
DROP TRIGGER sync_prop_insert;
DROP TRIGGER sync_prop_name;
DROP TRIGGER sync_prop_type;
DROP TRIGGER sync_prop_config;
DROP TRIGGER sync_prop_position;
DROP TRIGGER sync_prop_deleted;
DROP TRIGGER sync_view_insert;
DROP TRIGGER sync_view_name;
DROP TRIGGER sync_view_layout;
DROP TRIGGER sync_view_config;
DROP TRIGGER sync_view_position;
DROP TRIGGER sync_view_deleted;
DROP TRIGGER sync_row_insert;
DROP TRIGGER sync_row_cells;

CREATE TRIGGER sync_node_insert AFTER INSERT ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id,
          json_object('kind', NEW.kind, 'title', NEW.title, 'parent_id', NEW.parent_id, 'position', NEW.position, 'deleted_at', NEW.deleted_at),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_node_title AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.title IS NOT OLD.title
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('title', NEW.title), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_node_parent AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.parent_id IS NOT OLD.parent_id
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('parent_id', NEW.parent_id), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_node_position AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_node_deleted AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_doc_insert AFTER INSERT ON page_content
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0
 AND (SELECT workspace_id FROM node WHERE id = NEW.node_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  DELETE FROM oplog WHERE entity = 'doc' AND entity_id = NEW.node_id AND status = 'pending';
  INSERT INTO oplog (entity, entity_id, clock_ms) VALUES ('doc', NEW.node_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_doc_update AFTER UPDATE OF doc_state ON page_content
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0
 AND NEW.doc_state IS NOT OLD.doc_state
 AND (SELECT workspace_id FROM node WHERE id = NEW.node_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  DELETE FROM oplog WHERE entity = 'doc' AND entity_id = NEW.node_id AND status = 'pending';
  INSERT INTO oplog (entity, entity_id, clock_ms) VALUES ('doc', NEW.node_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_insert AFTER INSERT ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name, 'type', NEW.type,
          'config', json(NEW.config_json), 'position', NEW.position, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_name AFTER UPDATE OF name ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.name IS NOT OLD.name
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_type AFTER UPDATE OF type ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.type IS NOT OLD.type
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'type', NEW.type), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_config AFTER UPDATE OF config_json ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.config_json IS NOT OLD.config_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'config', json(NEW.config_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_position AFTER UPDATE OF position ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_deleted AFTER UPDATE OF deleted_at ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_insert AFTER INSERT ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name, 'layout', NEW.layout,
          'config', json(NEW.config_json), 'position', NEW.position, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_name AFTER UPDATE OF name ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.name IS NOT OLD.name
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_layout AFTER UPDATE OF layout ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.layout IS NOT OLD.layout
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'layout', NEW.layout), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_config AFTER UPDATE OF config_json ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.config_json IS NOT OLD.config_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'config', json(NEW.config_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_position AFTER UPDATE OF position ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_deleted AFTER UPDATE OF deleted_at ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_row_insert AFTER INSERT ON db_row
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('row', NEW.node_id, json_object('database_id', NEW.database_id, 'cells', json(NEW.props_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_row_cells AFTER UPDATE OF props_json ON db_row
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.props_json IS NOT OLD.props_json
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
