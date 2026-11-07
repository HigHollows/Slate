-- 0007 : pointages d'habitudes. Un jour = un pointage par ligne ; les séries et taux sont calculés, jamais stockés.
-- Pas de clé étrangère (même raison que reminder_fired) : les pointages d'une ligne purgée sont inertes.
CREATE TABLE habit_log (
  row_id     TEXT NOT NULL,
  day        TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (row_id, day)
) STRICT;
