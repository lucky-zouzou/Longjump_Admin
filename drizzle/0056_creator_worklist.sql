ALTER TABLE creator_profiles ADD COLUMN deleted_at TEXT;
ALTER TABLE creator_profiles ADD COLUMN follow_task_id TEXT;

-- Recover explicitly recorded follow-ups from before task identities were stored.
UPDATE creator_profiles AS p SET follow_task_id=(
 SELECT e.id FROM creator_events e WHERE e.creator_id=p.id AND e.action='follow'
 AND json_extract(e.detail_json,'$.next_action')=p.next_action
 AND e.created_at=p.last_follow_at ORDER BY e.rowid DESC LIMIT 1
) WHERE next_action<>'';

-- A completed delivery used to leave its earlier instruction on the profile.
UPDATE creator_profiles AS p SET next_action='',next_at=NULL
WHERE bd_stage='completed' AND follow_task_id IS NULL
 AND EXISTS (SELECT 1 FROM creator_rounds r WHERE r.creator_id=p.id AND r.status='completed' AND r.completed_at=p.last_follow_at)
 AND NOT EXISTS (SELECT 1 FROM creator_events e WHERE e.creator_id=p.id AND e.created_at>p.last_follow_at AND e.action IN ('follow','accept','contact','reply','handoff','queue','return','resume','tier','bdMaintain'));

CREATE INDEX idx_creator_dismissed_tasks ON creator_events(creator_id) WHERE action='deleteTask';

UPDATE creator_practices SET status=CASE WHEN json_extract(data_json,'$.shareConfirmed')=1 THEN 'approved' ELSE 'returned' END
WHERE status='pending';

INSERT INTO creator_bd_names(user_id,display_name)
SELECT id,'肖婉欣' FROM users WHERE lower(trim(email))='xwx@loongjump.com' AND role='达人BD'
ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name;
