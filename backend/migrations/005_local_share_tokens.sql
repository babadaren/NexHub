CREATE TABLE IF NOT EXISTS local_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES node_configs(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_local_share_tokens_node_id ON local_share_tokens(node_id);
CREATE INDEX IF NOT EXISTS idx_local_share_tokens_status ON local_share_tokens(status);
