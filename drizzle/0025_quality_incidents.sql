ALTER TABLE after_sales ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'after_sale' CHECK(record_kind IN ('after_sale','quality'));
--> statement-breakpoint
DROP INDEX idx_after_sales_case;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_after_sales_case ON after_sales(record_kind,site,channel,case_no,sku);
--> statement-breakpoint
CREATE INDEX idx_after_sales_kind_month ON after_sales(record_kind,business_date,status);
