-- 0008 : historique des versions de pages. Un instantané = l'état Yjs complet + le JSON + le texte brut.
-- Pas de clé étrangère (comme reminder_fired) : les versions d'une page purgée sont supprimées par `tree::purge`.
CREATE TABLE page_version (
  id           TEXT PRIMARY KEY NOT NULL,
  node_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('auto', 'manual', 'restore')),
  label        TEXT CHECK (label IS NULL OR length(label) <= 200),
  author       TEXT CHECK (author IS NULL OR length(author) <= 320),
  doc_state    BLOB NOT NULL,
  content_json TEXT NOT NULL,
  text_plain   TEXT NOT NULL,
  bytes        INTEGER NOT NULL
) STRICT;
CREATE INDEX page_version_node ON page_version (node_id, created_at DESC);
