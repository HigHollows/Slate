-- 0005 : verrouillage local par PIN. Le PIN n'est JAMAIS stocké : seulement son empreinte Argon2id (avec sel intégré).
CREATE TABLE security_local (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash       TEXT,
  lock_on_start  INTEGER NOT NULL DEFAULT 1 CHECK (lock_on_start IN (0, 1)),
  idle_minutes   INTEGER NOT NULL DEFAULT 0 CHECK (idle_minutes BETWEEN 0 AND 240),
  failed_count   INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until   INTEGER NOT NULL DEFAULT 0 CHECK (locked_until >= 0),
  updated_at     TEXT NOT NULL
) STRICT;
INSERT INTO security_local (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
