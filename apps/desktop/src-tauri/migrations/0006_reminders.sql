-- 0006 : rappels déjà notifiés. Clé = (ligne, propriété, instant) : changer l'heure du rappel le fait sonner à nouveau.
-- Pas de clé étrangère : une ligne purgée laisse au pire une ligne inerte (purgée avec `reminders::prune`).
CREATE TABLE reminder_fired (
  row_id       TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  fire_at      TEXT NOT NULL,
  acked_at     TEXT NOT NULL,
  PRIMARY KEY (row_id, property_id, fire_at)
) STRICT;
