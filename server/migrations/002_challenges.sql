-- Ephemeral WebAuthn challenges for registration and login ceremonies.
-- Single-use: consumed via DELETE ... RETURNING.

CREATE TABLE challenges (
  id                 text PRIMARY KEY,
  challenge          text NOT NULL,
  purpose            text NOT NULL,
  pending_profile_id text,
  pending_name       text,
  expires_at         timestamptz NOT NULL
);

CREATE INDEX challenges_expires_at_idx ON challenges (expires_at);
