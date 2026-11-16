CREATE INDEX IF NOT EXISTS idx_business_action_open_tasks
ON business_actions(site, channel, status, owner_id, collaborators_json, due_at, review_at,
                    ever_active, executed_at, json_extract(snapshot_json,'$.condition'))
WHERE status<>'resolved';
