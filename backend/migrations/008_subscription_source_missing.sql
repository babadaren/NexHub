ALTER TABLE node_configs
  ADD COLUMN IF NOT EXISTS source_missing BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_node_configs_source_missing ON node_configs(source_missing);
