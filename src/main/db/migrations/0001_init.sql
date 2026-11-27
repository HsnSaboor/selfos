-- SelfOS schema v1
-- Conventions (STACK.md §4.2): instants are UTC epoch ms (*_at); day-bucketed
-- tables also carry local_date TEXT (YYYY-MM-DD). Raw tables are append-only.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ── Time ────────────────────────────────────────────────────────────────
CREATE TABLE focus_event (
  id           INTEGER PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER NOT NULL,
  local_date   TEXT    NOT NULL,
  app_class    TEXT    NOT NULL,
  app_title    TEXT,
  workspace_id TEXT,
  monitor_id   INTEGER,
  source       TEXT    NOT NULL,
  session_id   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX focus_event_day  ON focus_event(local_date);
CREATE INDEX focus_event_time ON focus_event(started_at);

CREATE TABLE browser_profile (
  id            INTEGER PRIMARY KEY,
  browser       TEXT NOT NULL,
  profile_dir   TEXT NOT NULL UNIQUE,
  history_path  TEXT NOT NULL,
  watermark_us  TEXT NOT NULL DEFAULT '0',
  last_ingest_at INTEGER
);

CREATE TABLE browser_visit (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES browser_profile(id),
  url            TEXT NOT NULL,
  title          TEXT,
  domain         TEXT NOT NULL,
  visit_time_us  TEXT NOT NULL,
  visit_at       INTEGER NOT NULL,
  local_date     TEXT NOT NULL,
  duration_us    INTEGER NOT NULL DEFAULT 0,
  transition     INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'history',
  ingest_run_id  INTEGER,
  UNIQUE(profile_id, url, visit_time_us)
);
CREATE INDEX browser_visit_day ON browser_visit(local_date);

CREATE TABLE domain_rule (
  domain         TEXT PRIMARY KEY,
  category       TEXT NOT NULL,
  is_distracting INTEGER NOT NULL DEFAULT 0,
  is_media       INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE ingest_run (
  id          INTEGER PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES browser_profile(id),
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  rows_read   INTEGER NOT NULL DEFAULT 0,
  rows_new    INTEGER NOT NULL DEFAULT 0,
  strategy    TEXT,
  error       TEXT
);

-- ── Reading ─────────────────────────────────────────────────────────────
CREATE TABLE book (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  file_path     TEXT NOT NULL,
  source_path   TEXT,
  sha256        TEXT NOT NULL UNIQUE,
  page_count    INTEGER NOT NULL,
  settings_json TEXT,
  added_at      INTEGER NOT NULL,
  archived_at   INTEGER
);

CREATE TABLE reading_position (
  book_id       INTEGER PRIMARY KEY REFERENCES book(id),
  page          INTEGER NOT NULL,
  scroll_offset REAL NOT NULL DEFAULT 0,
  zoom          REAL NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE reading_session (
  id             INTEGER PRIMARY KEY,
  book_id        INTEGER NOT NULL REFERENCES book(id),
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL,
  local_date     TEXT NOT NULL,
  pages_turned   INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL
);
CREATE INDEX reading_session_day ON reading_session(local_date);

CREATE TABLE highlight (
  id             INTEGER PRIMARY KEY,
  book_id        INTEGER NOT NULL REFERENCES book(id),
  page           INTEGER NOT NULL,
  color          TEXT NOT NULL,
  text           TEXT NOT NULL,
  rects_json     TEXT NOT NULL,
  rotation       INTEGER NOT NULL DEFAULT 0,
  anchor_version INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX highlight_book ON highlight(book_id, page);

CREATE TABLE highlight_note (
  highlight_id INTEGER PRIMARY KEY REFERENCES highlight(id),
  body         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ── Habits ──────────────────────────────────────────────────────────────
CREATE TABLE habit (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  unit        TEXT,
  target      REAL,
  icon        TEXT,
  color       TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE habit_schedule (
  id               INTEGER PRIMARY KEY,
  habit_id         INTEGER NOT NULL REFERENCES habit(id),
  effective_from   TEXT NOT NULL,
  kind             TEXT NOT NULL,
  weekdays         TEXT,
  times_per_period INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE(habit_id, effective_from)
);

CREATE TABLE habit_entry (
  id         INTEGER PRIMARY KEY,
  habit_id   INTEGER NOT NULL REFERENCES habit(id),
  local_date TEXT NOT NULL,
  value      REAL NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  note       TEXT,
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  UNIQUE(habit_id, local_date)
);

-- ── Salah ───────────────────────────────────────────────────────────────
CREATE TABLE prayer_log (
  id          INTEGER PRIMARY KEY,
  local_date  TEXT NOT NULL,
  prayer      TEXT NOT NULL,
  status      TEXT NOT NULL,
  jamaah      INTEGER NOT NULL DEFAULT 0,
  masjid      TEXT,
  prayer_time TEXT NOT NULL,
  logged_at   INTEGER NOT NULL,
  UNIQUE(local_date, prayer)
);

CREATE TABLE qada_event (
  id         INTEGER PRIMARY KEY,
  prayer     TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE fasting_log (
  local_date TEXT PRIMARY KEY,
  fasted     INTEGER NOT NULL,
  tarawih    INTEGER NOT NULL DEFAULT 0,
  note       TEXT
);

-- ── Goals ───────────────────────────────────────────────────────────────
CREATE TABLE goal (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  kind         TEXT NOT NULL,
  target_value REAL,
  unit         TEXT,
  start_date   TEXT NOT NULL,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  source       TEXT,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);

CREATE TABLE goal_progress (
  id      INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  at      INTEGER NOT NULL,
  value   REAL NOT NULL,
  source  TEXT NOT NULL,
  note    TEXT
);

CREATE TABLE goal_milestone (
  id       INTEGER PRIMARY KEY,
  goal_id  INTEGER NOT NULL REFERENCES goal(id),
  title    TEXT NOT NULL,
  due_date TEXT,
  done_at  INTEGER,
  sort     INTEGER NOT NULL DEFAULT 0
);

-- ── Cross-module ────────────────────────────────────────────────────────
CREATE TABLE note_link (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  note_path   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(entity_type, entity_id, note_path)
);

CREATE TABLE day_aggregate (
  local_date      TEXT PRIMARY KEY,
  screen_seconds  INTEGER NOT NULL DEFAULT 0,
  focused_seconds INTEGER NOT NULL DEFAULT 0,
  media_seconds   INTEGER NOT NULL DEFAULT 0,
  reading_seconds INTEGER NOT NULL DEFAULT 0,
  switches        INTEGER NOT NULL DEFAULT 0,
  first_activity  INTEGER,
  last_activity   INTEGER,
  rebuilt_at      INTEGER NOT NULL
);
