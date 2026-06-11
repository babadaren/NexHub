CREATE TABLE IF NOT EXISTS subscription_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT,
  content TEXT,
  auto_refresh BOOLEAN NOT NULL DEFAULT false,
  refresh_cron TEXT,
  last_refresh_status TEXT DEFAULT 'never',
  last_refresh_message TEXT,
  last_refresh_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_sources_updated_at ON subscription_sources(updated_at DESC);
