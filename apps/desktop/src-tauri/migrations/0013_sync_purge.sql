-- Suppression définitive propagée : la suppression d'une ligne `node` (corbeille vidée / purge) devient une opération
-- « purged_at ». L'espace est inscrit dans l'opération, car le nœud n'existe plus pour le retrouver.
CREATE TRIGGER sync_node_purge AFTER DELETE ON node
WHEN (SELECT enabled FROM sync_settings WHERE id = 1) = 1 AND (SELECT applying FROM sync_settings WHERE id = 1) = 0 AND OLD.workspace_id IN (SELECT workspace_id FROM sync_state WHERE enabled = 1)
BEGIN
  INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
  VALUES ('node', OLD.id, json_object('purged_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'workspace_id', OLD.workspace_id),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
