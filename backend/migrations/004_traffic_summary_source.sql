ALTER TABLE daily_traffic_summaries
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'estimated',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_daily_traffic_summaries_day ON daily_traffic_summaries(day DESC);
