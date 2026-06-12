ALTER TABLE subscription_sources
  ADD COLUMN IF NOT EXISTS encrypted_url TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'url',
  ADD COLUMN IF NOT EXISTS auto_enable_new_nodes BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_private_network BOOLEAN NOT NULL DEFAULT false;
