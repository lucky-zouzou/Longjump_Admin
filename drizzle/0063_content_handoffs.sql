ALTER TABLE content_scripts ADD COLUMN studio_user_id TEXT REFERENCES users(id);
UPDATE content_scripts AS s SET studio_user_id=(
 SELECT u.id FROM content_events e JOIN users u ON u.id=e.actor_id
 WHERE e.action='schedule' AND e.result_id=s.id AND u.active=1 AND u.role='拍摄剪辑'
 ORDER BY e.seq DESC LIMIT 1
) WHERE source='studio' AND status IN ('已排期','待验收','待改拍');
