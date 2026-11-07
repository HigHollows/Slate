-- 0009 : commentaires ancrés. L'ancrage dans le texte est une MARQUE du document (suit les modifications, y compris
-- concurrentes, car elle vit dans l'état Yjs) ; ici ne sont stockés que les fils et leurs messages.
-- Pas de clé étrangère vers `node` (comme page_version) : `tree::purge` supprime les commentaires avec la page.
CREATE TABLE comment_thread (
  id           TEXT PRIMARY KEY NOT NULL,
  node_id      TEXT NOT NULL,
  quote        TEXT NOT NULL CHECK (length(quote) <= 400),
  created_at   TEXT NOT NULL,
  created_by   TEXT CHECK (created_by IS NULL OR length(created_by) <= 320),
  resolved_at  TEXT,
  resolved_by  TEXT CHECK (resolved_by IS NULL OR length(resolved_by) <= 320)
) STRICT;
CREATE INDEX comment_thread_node ON comment_thread (node_id, created_at);

CREATE TABLE comment (
  id         TEXT PRIMARY KEY NOT NULL,
  thread_id  TEXT NOT NULL REFERENCES comment_thread(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  author     TEXT CHECK (author IS NULL OR length(author) <= 320),
  created_at TEXT NOT NULL,
  edited_at  TEXT
) STRICT;
CREATE INDEX comment_thread_idx ON comment (thread_id, created_at);
