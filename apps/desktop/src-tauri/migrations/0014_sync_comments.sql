-- 0014 : commentaires partagés. `oplog.entity` accepte « thread » et « comment » (reconstruction de la table, comme 0011) ;
-- les déclencheurs qui écrivent dans `oplog` sont retirés puis recréés à l'identique. Voir docs/COLLABORATION.md.

DROP TRIGGER sync_doc_insert;
DROP TRIGGER sync_doc_update;
DROP TRIGGER sync_node_deleted;
DROP TRIGGER sync_node_insert;
DROP TRIGGER sync_node_parent;
DROP TRIGGER sync_node_position;
DROP TRIGGER sync_node_purge;
DROP TRIGGER sync_node_title;
DROP TRIGGER sync_prop_config;
DROP TRIGGER sync_prop_deleted;
DROP TRIGGER sync_prop_insert;
DROP TRIGGER sync_prop_name;
DROP TRIGGER sync_prop_position;
DROP TRIGGER sync_prop_type;
DROP TRIGGER sync_row_cells;
DROP TRIGGER sync_row_insert;
DROP TRIGGER sync_view_config;
DROP TRIGGER sync_view_deleted;
DROP TRIGGER sync_view_insert;
DROP TRIGGER sync_view_layout;
DROP TRIGGER sync_view_name;
DROP TRIGGER sync_view_position;

CREATE TABLE oplog_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id      TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  entity     TEXT NOT NULL CHECK (entity IN ('node', 'doc', 'prop', 'view', 'row', 'thread', 'comment')),
  entity_id  TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields_json)),
  clock_ms   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
INSERT INTO oplog_new (seq, op_id, entity, entity_id, fields_json, clock_ms, status, attempts, last_error, created_at) SELECT seq, op_id, entity, entity_id, fields_json, clock_ms, status, attempts, last_error, created_at FROM oplog;
DROP TABLE oplog;
ALTER TABLE oplog_new RENAME TO oplog;
CREATE INDEX oplog_pending ON oplog (status, seq);
CREATE INDEX oplog_entity ON oplog (entity, entity_id, status);

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

CREATE TRIGGER sync_node_deleted AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_node_insert AFTER INSERT ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id,
          json_object('kind', NEW.kind, 'title', NEW.title, 'parent_id', NEW.parent_id, 'position', NEW.position, 'deleted_at', NEW.deleted_at),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
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

CREATE TRIGGER sync_node_purge AFTER DELETE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND OLD.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', OLD.id, json_object('purged_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'workspace_id', OLD.workspace_id),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_node_title AFTER UPDATE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND NEW.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.title IS NOT OLD.title
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', NEW.id, json_object('title', NEW.title), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_config AFTER UPDATE OF config_json ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.config_json IS NOT OLD.config_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'config', json(NEW.config_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_deleted AFTER UPDATE OF deleted_at ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
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

CREATE TRIGGER sync_prop_position AFTER UPDATE OF position ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_prop_type AFTER UPDATE OF type ON db_property
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.type IS NOT OLD.type
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('prop', NEW.id, json_object('database_id', NEW.database_id, 'type', NEW.type), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
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

CREATE TRIGGER sync_row_insert AFTER INSERT ON db_row
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('row', NEW.node_id, json_object('database_id', NEW.database_id, 'cells', json(NEW.props_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_config AFTER UPDATE OF config_json ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.config_json IS NOT OLD.config_json
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'config', json(NEW.config_json)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_deleted AFTER UPDATE OF deleted_at ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_insert AFTER INSERT ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name, 'layout', NEW.layout,
          'config', json(NEW.config_json), 'position', NEW.position, 'deleted_at', NEW.deleted_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_layout AFTER UPDATE OF layout ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.layout IS NOT OLD.layout
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'layout', NEW.layout), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_name AFTER UPDATE OF name ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.name IS NOT OLD.name
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'name', NEW.name), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_view_position AFTER UPDATE OF position ON db_view
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.database_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.position IS NOT OLD.position
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('view', NEW.id, json_object('database_id', NEW.database_id, 'position', NEW.position), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- ── Déclencheurs des commentaires ─────────────────────────────────────────────────────────────────────────────────
-- Fil : création, résolution / réouverture, suppression. Message : création, modification, suppression.
-- Les suppressions inscrivent l'espace dans l'opération (la ligne n'existe plus pour le retrouver). Supprimer un fil dont la
-- page est dans la corbeille (purge) n'est PAS une action de l'utilisateur : le serveur efface les fils avec la page.
CREATE TRIGGER sync_thread_insert AFTER INSERT ON comment_thread
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.node_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('thread', NEW.id, json_object('node_id', NEW.node_id, 'quote', NEW.quote, 'created_at', NEW.created_at, 'resolved_at', NEW.resolved_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_thread_resolved AFTER UPDATE ON comment_thread
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = NEW.node_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.resolved_at IS NOT OLD.resolved_at
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('thread', NEW.id, json_object('resolved_at', NEW.resolved_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_thread_delete AFTER DELETE ON comment_thread
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT workspace_id FROM node WHERE id = OLD.node_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND (SELECT deleted_at FROM node WHERE id = OLD.node_id) IS NULL
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('thread', OLD.id, json_object('deleted_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'workspace_id', (SELECT workspace_id FROM node WHERE id = OLD.node_id)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_comment_insert AFTER INSERT ON comment
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT n.workspace_id FROM comment_thread t JOIN node n ON n.id = t.node_id WHERE t.id = NEW.thread_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('comment', NEW.id, json_object('thread_id', NEW.thread_id, 'body', NEW.body, 'created_at', NEW.created_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

CREATE TRIGGER sync_comment_body AFTER UPDATE ON comment
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT n.workspace_id FROM comment_thread t JOIN node n ON n.id = t.node_id WHERE t.id = NEW.thread_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND NEW.body IS NOT OLD.body
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('comment', NEW.id, json_object('body', NEW.body), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- Quand tout le fil est supprimé, la ligne du fil a déjà disparu au moment où ses messages partent en cascade : rien à envoyer
-- (le fil supprimé suffit). Seul un message supprimé seul d'un fil qui existe encore est une opération.
CREATE TRIGGER sync_comment_delete AFTER DELETE ON comment
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND (SELECT n.workspace_id FROM comment_thread t JOIN node n ON n.id = t.node_id WHERE t.id = OLD.thread_id) IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('comment', OLD.id, json_object('deleted_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'workspace_id', (SELECT n.workspace_id FROM comment_thread t JOIN node n ON n.id = t.node_id WHERE t.id = OLD.thread_id)), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- Rattrapage : les commentaires déjà présents dans un espace déjà synchronisé partent au prochain passage (le serveur ignore
-- ce qu'il connaît : opérations idempotentes). Fils avant messages.
INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
SELECT 'thread', t.id, json_object('node_id', t.node_id, 'quote', t.quote, 'created_at', t.created_at, 'resolved_at', t.resolved_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM comment_thread t JOIN node n ON n.id = t.node_id
WHERE (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND n.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND n.deleted_at IS NULL
ORDER BY t.created_at, t.id;
INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
SELECT 'comment', c.id, json_object('thread_id', c.thread_id, 'body', c.body, 'created_at', c.created_at), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM comment c JOIN comment_thread t ON t.id = c.thread_id JOIN node n ON n.id = t.node_id
WHERE (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND n.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1) AND n.deleted_at IS NULL
ORDER BY c.created_at, c.id;
