ALTER TABLE content_metrics ADD COLUMN gmv_minor INTEGER CHECK(gmv_minor IS NULL OR gmv_minor >= 0);
ALTER TABLE content_metrics ADD COLUMN currency TEXT CHECK(
  (gmv_minor IS NULL AND currency IS NULL) OR
  (gmv_minor IS NOT NULL AND currency IS NOT NULL AND currency IN ('IDR','MYR','THB','VND','PHP','USD','CNY'))
);
CREATE INDEX content_posts_compass_period ON content_posts(site,published_at) WHERE published_at IS NOT NULL;
