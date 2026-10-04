-- Nightly snapshots of profile data for backup and point-in-time recovery.
-- Old snapshots (> 30 days) are pruned during nightly cron.

CREATE TABLE profile_snapshots (
  id         bigserial PRIMARY KEY,
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  state      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profile_snapshots_profile_id_created_at_idx
  ON profile_snapshots (profile_id, created_at DESC);
