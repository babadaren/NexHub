CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

DO $$ BEGIN
  CREATE TYPE node_direction AS ENUM ('remote', 'local');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE node_status AS ENUM ('draft', 'enabled', 'disabled', 'error');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS node_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction node_direction NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status node_status NOT NULL DEFAULT 'draft',
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL,
  safe_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_test_status TEXT,
  last_test_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_node_configs_direction ON node_configs(direction);
CREATE INDEX IF NOT EXISTS idx_node_configs_protocol ON node_configs(protocol);
CREATE INDEX IF NOT EXISTS idx_node_configs_updated_at ON node_configs(updated_at DESC);

CREATE TABLE IF NOT EXISTS node_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES node_configs(id) ON DELETE CASCADE,
  version INT NOT NULL,
  config JSONB NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(node_id, version)
);

CREATE TABLE IF NOT EXISTS node_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID REFERENCES node_configs(id) ON DELETE SET NULL,
  direction node_direction NOT NULL,
  test_type TEXT NOT NULL,
  final_status TEXT NOT NULL,
  latency_ms INT,
  download_mbps NUMERIC(12, 2),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  human_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_node_test_results_node_time ON node_test_results(node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_traffic_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL,
  node_id UUID REFERENCES node_configs(id) ON DELETE CASCADE,
  direction node_direction NOT NULL,
  upload_bytes BIGINT NOT NULL DEFAULT 0,
  download_bytes BIGINT NOT NULL DEFAULT 0,
  max_latency_ms INT,
  avg_latency_ms INT,
  error_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(day, node_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
