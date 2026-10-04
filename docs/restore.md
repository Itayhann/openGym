# Restoring from a Snapshot

openGym takes a nightly snapshot of the profile's data into the `profile_snapshots` table via `/api/cron/snapshot`. Snapshots older than 30 days are automatically pruned.

To restore a snapshot back to live data:

## 1. List available snapshots

Connect to your database (e.g. via `psql` or the Neon console) and query snapshots for your profile:

```sql
SELECT id, created_at, (state->>'_ts') AS state_timestamp
  FROM profile_snapshots
 WHERE profile_id = (SELECT id FROM profiles LIMIT 1)
 ORDER BY created_at DESC;
```

## 2. Restore the desired snapshot

Run the following query to copy the chosen snapshot's data back into `profile_data`:

```sql
INSERT INTO profile_data (profile_id, state, updated_at)
SELECT profile_id, state, now()
  FROM profile_snapshots
 WHERE id = <SNAPSHOT_ID>
ON CONFLICT (profile_id)
DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at;
```

Replace `<SNAPSHOT_ID>` with the `id` from step 1.

## 3. Verify in the app

Open the app on your device or call `GET /api/data`. The app will pull and sync the restored workout history, routines, and profile settings immediately.
