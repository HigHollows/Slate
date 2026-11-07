-- 0010 : synchronisation (première tranche, voir docs/SYNC.md). Les déclencheurs inscrivent l'opération dans la
-- MÊME transaction que la modification : aucune écriture synchronisable sans opération associée.
-- Tant que `sync_settings.enabled = 0` (mode invité), aucun déclencheur n'écrit : la file ne grossit pas.
CREATE TABLE sync_settings (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  workspace_id TEXT,
  device_id    TEXT NOT NULL,
  -- 1 pendant l'application de données distantes : les déclencheurs se taisent (pas d'écho vers le serveur).
  applying     INTEGER NOT NULL DEFAULT 0 CHECK (applying IN (0, 1))
) STRICT;
INSERT INTO sync_settings (id, device_id) VALUES (1, (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))));

CREATE TABLE oplog (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id      TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  entity     TEXT NOT NULL CHECK (entity IN ('node', 'doc')),
  entity_id  TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields_json)),
  clock_ms   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rejected')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX oplog_pending ON oplog (status, seq);
CREATE INDEX oplog_entity ON oplog (entity, entity_id, status);

CREATE TABLE sync_state (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  node_cursor  INTEGER NOT NULL DEFAULT 0,
  doc_cursor   INTEGER NOT NULL DEFAULT 0,
  last_push_at TEXT,
  last_pull_at TEXT,
  last_error   TEXT
) STRICT;

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

-- Contenu : une seule opération « doc » en attente par page (l'état Yjs complet est lu au moment de l'envoi ; une
-- opération plus récente remplace donc la précédente non envoyée).
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
