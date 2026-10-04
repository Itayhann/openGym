-- Profile data storage: stores the sync state JSON document for each profile.
-- In-progress workouts (active) are stripped before writing.

CREATE TABLE profile_data (
  profile_id text PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  state      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
