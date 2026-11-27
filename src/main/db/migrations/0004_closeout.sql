-- M9 (close-out): reminders, linked habits, retention and the notes audit.
--
-- These are additive; existing rows keep working.

-- F-HABIT-11: one row per delivered reminder, so a reminder fires once per day.
CREATE TABLE IF NOT EXISTS notification_log (
  key        TEXT PRIMARY KEY,   -- YYYY-MM-DD:<habitId>:<HH:MM>
  sent_at    INTEGER NOT NULL
);

-- F-HABIT-13: an optional module metric that auto-completes a habit.
ALTER TABLE habit ADD COLUMN link TEXT;
ALTER TABLE habit ADD COLUMN remind_at TEXT;

-- F-TIME-15: hourly downsample of raw focus events older than the retention
-- window. Daily aggregates are kept forever.
CREATE TABLE IF NOT EXISTS focus_hourly (
  local_date  TEXT    NOT NULL,
  hour        INTEGER NOT NULL,
  app_class   TEXT    NOT NULL,
  seconds     INTEGER NOT NULL,
  PRIMARY KEY (local_date, hour, app_class)
);

-- F-NOTES / C-9: an audit trail for writes to the user's vault.
CREATE TABLE IF NOT EXISTS note_audit (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  action     TEXT    NOT NULL,   -- append | create
  path       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL
);

-- F-TIME-12: explicit "not tracked" ranges (gaps the user declared).
CREATE TABLE IF NOT EXISTS untracked_range (
  from_date TEXT PRIMARY KEY,
  to_date   TEXT NOT NULL,
  reason    TEXT
);
ALTER TABLE day_aggregate ADD COLUMN switches_per_hour REAL NOT NULL DEFAULT 0;
