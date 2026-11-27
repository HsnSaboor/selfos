-- M1/M7: focus-session accounting (PRD F-TIME-08) and the longest focus stretch
-- (F-TIME-10). Both are derived from focus_event and stored on the day
-- aggregate so the dashboard and analytics read one row.
--
-- A focus session is a contiguous run of segments for the same app class whose
-- total length is at least FOCUS_SESSION_MIN_MS (5 minutes). Short glances are
-- still screen time and still excluded from focused time by the existing
-- switch-noise rule; they simply do not open a session.

ALTER TABLE day_aggregate ADD COLUMN focus_sessions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE day_aggregate ADD COLUMN longest_focus_seconds INTEGER NOT NULL DEFAULT 0;