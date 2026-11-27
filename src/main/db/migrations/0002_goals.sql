-- M6: goal nesting and the reason a goal was closed (F-GOAL-07, F-GOAL-08).
--
-- `goal.parent_id` allows annual -> quarterly -> weekly roll-up. `close_reason`
-- keeps the audit trail when a goal is completed or abandoned instead of
-- deleting it. Both are additive, so existing rows keep working untouched.

ALTER TABLE goal ADD COLUMN parent_id INTEGER REFERENCES goal(id);
ALTER TABLE goal ADD COLUMN close_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_goal_parent ON goal(parent_id);
CREATE INDEX IF NOT EXISTS idx_goal_status ON goal(status, target_date);
CREATE INDEX IF NOT EXISTS idx_goal_progress_goal ON goal_progress(goal_id, at);
CREATE INDEX IF NOT EXISTS idx_goal_milestone_goal ON goal_milestone(goal_id, sort);
