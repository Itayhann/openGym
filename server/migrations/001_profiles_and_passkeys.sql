-- The Profile is the one account on an instance; Passkeys belong to it.
-- Later migrations add their own tables (data, push, alerts, challenges, snapshots) with the
-- ticket that needs them.

CREATE TABLE profiles (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  disabled           boolean NOT NULL DEFAULT false,
  session_version    integer NOT NULL DEFAULT 0,
  last_reminder_date date
);

CREATE TABLE passkeys (
  credential_id text PRIMARY KEY,
  profile_id    text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  public_key    text NOT NULL,          -- base64url COSE key; the server only ever stores the public half
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX passkeys_profile_id_idx ON passkeys (profile_id);
