-- Public form traffic is isolated from the signed website inquiry integration.
CREATE INDEX distributor_application_created ON website_leads(created_at)
WHERE source='distributor-application';

CREATE TRIGGER distributor_application_hourly_limit
BEFORE INSERT ON website_leads
WHEN NEW.source='distributor-application' AND (
  SELECT count(*) FROM website_leads WHERE source='distributor-application'
    AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')
) >= 240
BEGIN
  SELECT RAISE(ABORT,'distributor_application_limit');
END;
