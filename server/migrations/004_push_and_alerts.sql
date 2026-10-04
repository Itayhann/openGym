-- Push subscriptions and rest alerts.

CREATE TABLE push_subscriptions (
  endpoint   text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_profile_id_idx ON push_subscriptions (profile_id);

CREATE TABLE rest_alerts (
  profile_id text PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  id         text NOT NULL,
  due_at     timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rest_alerts_due_at_idx ON rest_alerts (due_at);
