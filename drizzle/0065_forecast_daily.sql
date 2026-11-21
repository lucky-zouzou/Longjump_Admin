CREATE TABLE forecast_daily_observations (
  business_date TEXT NOT NULL,
  site TEXT NOT NULL,
  channel TEXT NOT NULL,
  sku TEXT NOT NULL,
  first_json TEXT NOT NULL,
  latest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (business_date,site,channel,sku)
);
CREATE INDEX forecast_daily_scope ON forecast_daily_observations(site,channel,business_date);
