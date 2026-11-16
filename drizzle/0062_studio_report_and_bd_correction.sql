UPDATE users SET name='肖婉欣', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE lower(trim(email))='xwx@loongjump.com' AND role='达人BD' AND name<>'肖婉欣';

INSERT INTO creator_bd_names(user_id,display_name)
SELECT id,'肖婉欣' FROM users WHERE lower(trim(email))='xwx@loongjump.com' AND role='达人BD'
ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name;

ALTER TABLE creator_rounds ADD COLUMN test_archived_at TEXT;
UPDATE creator_rounds AS r SET status='cancelled',version=version+1,
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),test_archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE round_no='BD-20261106-B90D729A' AND status='pending' AND approved_at IS NULL AND approver_id IS NULL
 AND completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(r.logistics_json))
 AND EXISTS (SELECT 1 FROM creator_profiles p JOIN creator_scopes s ON s.id=p.scope_id WHERE p.id=r.creator_id
 AND (lower(ltrim(p.platform_id,'@'))='neuisrosita' OR lower(trim(p.name))='neuisrosita') AND lower(trim(s.shop))='loong jump' AND s.site='印尼' AND lower(s.platform)='tiktok')
 AND NOT EXISTS (SELECT 1 FROM creator_contents c WHERE c.round_id=r.id)
 AND NOT EXISTS (SELECT 1 FROM creator_finance f WHERE f.round_id=r.id);
INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at)
SELECT '0062-archive-'||id,'archiveTestRound','creator_round',id,
 json_object('roundNo',round_no,'from','pending','to','cancelled','reason','已确认的未批准测试单，归档并撤下审批待办'),
 'migration:0062','系统数据校正',test_archived_at FROM creator_rounds
WHERE round_no='BD-20261106-B90D729A' AND test_archived_at IS NOT NULL;
UPDATE creator_requests SET state='cancelled',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE round_id IN (SELECT id FROM creator_rounds WHERE test_archived_at IS NOT NULL) AND state<>'cancelled';

CREATE TABLE content_platform_reports (
 site TEXT NOT NULL, start_day TEXT NOT NULL, end_day TEXT NOT NULL, video_id TEXT NOT NULL,
 revision INTEGER NOT NULL, currency TEXT NOT NULL, metrics_json TEXT NOT NULL,
 source_file TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 PRIMARY KEY(site,start_day,end_day,video_id,revision)
);
