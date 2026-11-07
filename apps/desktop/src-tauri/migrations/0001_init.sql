-- 0001 : socle. Identité de l'appareil et préférences.
-- Les tables métier arrivent avec les phases suivantes (cf. DATA_MODEL.md).

CREATE TABLE device (
  id          TEXT PRIMARY KEY NOT NULL,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'device')),
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL
) STRICT;
