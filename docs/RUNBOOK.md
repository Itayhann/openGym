# openGym Owner Runbook

This runbook is the single-owner operational guide for deploying, managing, and recovering this `openGym` instance on **Vercel + Neon Postgres**. It is written so that any operation can be executed months later without prior context.

> [!IMPORTANT]
> **Hostname Immutability**: The production hostname (`opengym-itay.vercel.app`) and origin (`https://opengym-itay.vercel.app`) must **never change**. Passkeys are cryptographically bound to the Relying Party ID (`RP_ID`) by device authenticators (such as Apple Face ID / iCloud Keychain). Changing the domain or hostname causes authenticators to refuse existing credentials, permanently locking out registered Passkeys and breaking Web Push subscriptions.

---

## Glossary & Core Concepts

- **Profile**: The single account on this instance (`MAX_PROFILES=1`): its name, passkeys, and synced history (workouts, routines, and body-weight logs). Data belongs to the Profile, never to a device.
- **Passkey**: The WebAuthn credential held in your phone's keychain that signs you in, bound to the instance's hostname. The server only stores the public key.
- **Setup code**: A temporary secret (`SETUP_CODE`) required for first registration or Re-enrolment. It is removed once registration is complete.
- **Re-enrolment**: Attaching a new Passkey to your existing Profile after losing a device or credential, preserving all saved data.
- **Active workout**: A workout in progress. It lives on your device only and is never synced; once finished, it becomes a logged workout in Profile data.
- **Rest alert**: Push notification alerting you that rest between sets is over while the app is backgrounded.
- **Daily reminder**: Push notification sent at your chosen reminder time on days with a planned workout and none logged yet.
- **Home-screen install**: The app added to your iPhone home screen from Safari (Share → Add to Home Screen). It is the only form of the app on iPhone, and the only one that receives Web Push.

---

## 1. Deploy

To deploy a new instance or apply database migrations from your computer:

1. **Create the Vercel Project**:
   In the Vercel dashboard, create a new project named `opengym-itay` connected to the GitHub repository `Itayhann/openGym`. Set Framework Preset to **Vite**.

2. **Attach Neon Postgres**:
   In the Vercel project's **Storage** tab, add a **Neon Postgres** database through the Vercel Marketplace on the free plan. This automatically provisions and sets `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct).

3. **Configure Environment Variables**:
   In the Vercel project settings (**Settings → Environment Variables**), configure the following production variables:
   - `RP_ID`: `opengym-itay.vercel.app` (must never change)
   - `ORIGIN`: `https://opengym-itay.vercel.app` (must never change)
   - `RP_NAME`: `openGym`
   - `MAX_PROFILES`: `1`
   - `SESSION_SECRET`: 64-character random hex string generated via:
     ```bash
     node -e "console.log(crypto.randomBytes(32).toString('hex'))"
     ```
   - `CRON_SECRET`: random secret string generated via:
     ```bash
     node -e "console.log(crypto.randomBytes(32).toString('hex'))"
     ```
   - `VAPID_PUBLIC_KEY` & `VAPID_PRIVATE_KEY`: generated via:
     ```bash
     npx web-push generate-vapid-keys
     ```
   - `VAPID_SUBJECT`: `mailto:owner@example.com`
   - `SETUP_CODE`: random alphanumeric string for initial registration generated via:
     ```bash
     node -e "console.log(crypto.randomBytes(12).toString('base64url'))"
     ```

4. **Pull Environment and Run Migrations**:
   On your local machine, pull the production environment variables and run database migrations using the unpooled connection string:
   ```bash
   vercel env pull .env.local
   npm run migrate
   ```

5. **Deploy and Verify**:
   Deploy the `main` branch to production (or trigger a redeploy in Vercel). Verify the deployment health endpoint returns `ok: true`:
   ```bash
   curl -s https://opengym-itay.vercel.app/api/health
   ```

---

## 2. First Registration with the Setup code

To register your Profile and first Passkey:

1. **Install App**: On your iPhone, open Safari, navigate to `https://opengym-itay.vercel.app`, tap the **Share** button, and tap **Add to Home Screen** to create your **Home-screen install**.
2. **Open App**: Tap the **Home-screen install** icon on your home screen. The app opens full-screen and displays the registration form prompting for a name and **Setup code**.
3. **Register Passkey**: Enter your desired Profile name and the value of `SETUP_CODE` configured in Vercel. Tap **Create Profile** and complete the Face ID / Touch ID prompt to register your **Passkey**.
4. **Remove Setup Code**: After successful registration and sign-in, remove the `SETUP_CODE` environment variable from Vercel so that no further registrations are permitted:
   ```bash
   vercel env rm SETUP_CODE production
   ```

---

## 3. Re-enrolment after losing a Passkey

If you lose your device or your Passkey is deleted from your keychain, use this procedure to attach a new Passkey to your existing Profile without losing any data:

1. **Add Temporary Setup Code**:
   Generate a new temporary `SETUP_CODE` and add it to your production Vercel environment:
   ```bash
   node -e "console.log(crypto.randomBytes(12).toString('base64url'))"
   vercel env add SETUP_CODE production
   ```
2. **Pull Unpooled Connection String**:
   Pull `.env.local` to obtain `DATABASE_URL_UNPOOLED`:
   ```bash
   vercel env pull .env.local
   ```
3. **Run Break-Glass Passkey Reset**:
   Run the break-glass reset script. It displays the target database host, requires typing the exact hostname to confirm, deletes existing passkeys, increments the session version, and leaves Profile data untouched:
   ```bash
   npm run break-glass
   ```
4. **Re-enrol from Device**:
   On your new phone, open Safari, navigate to `https://opengym-itay.vercel.app`, perform the **Home-screen install**, open the app, enter your Profile name and the new `SETUP_CODE`, and approve the Face ID prompt. This attaches a new **Passkey** to your existing Profile via **Re-enrolment**.
5. **Verify and Clean Up**:
   Verify that your workout history, routines, and weight logs are intact, then delete the `SETUP_CODE` environment variable from Vercel:
   ```bash
   vercel env rm SETUP_CODE production
   ```

---

## 4. Restoring a snapshot

openGym takes a nightly snapshot of your Profile data into the `profile_snapshots` table via `/api/cron/snapshot` (scheduled at `0 3 * * *` in UTC) and retains 30 days of history. Note that **Active workouts** are device-local and not synced until completed. To restore data from a snapshot:

1. **Pull Database Connection**:
   Pull `.env.local` to get `DATABASE_URL_UNPOOLED`:
   ```bash
   vercel env pull .env.local
   ```
2. **List Available Snapshots**:
   Connect via `psql` (or Neon SQL Console) and list recent snapshots for your Profile:
   ```bash
   psql "$DATABASE_URL_UNPOOLED" -c "SELECT id, created_at, (state->>'_ts') AS state_ts FROM profile_snapshots WHERE profile_id = (SELECT id FROM profiles LIMIT 1) ORDER BY created_at DESC;"
   ```
3. **Restore Selected Snapshot**:
   Restore the chosen snapshot by replacing `<SNAPSHOT_ID>` with the desired snapshot `id`:
   ```bash
   psql "$DATABASE_URL_UNPOOLED" -c "INSERT INTO profile_data (profile_id, state, updated_at) SELECT profile_id, state, now() FROM profile_snapshots WHERE id = <SNAPSHOT_ID> ON CONFLICT (profile_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at;"
   ```
4. **Verify Live Data**:
   Open the **Home-screen install** on your phone (or call `GET /api/data`). The app immediately displays the restored routines and workout logs.

---

## 5. Exporting data

To export a full offline backup of your Profile data:

1. **Pull Database Connection**:
   Pull `.env.local` to get `DATABASE_URL_UNPOOLED`:
   ```bash
   vercel env pull .env.local
   ```
2. **Direct Database Export**:
   Export the complete JSON state document directly from `profile_data` to a timestamped file:
   ```bash
   psql "$DATABASE_URL_UNPOOLED" -t -A -c "SELECT state FROM profile_data WHERE profile_id = (SELECT id FROM profiles LIMIT 1);" > "opengym-backup-$(date +%Y%m%d).json"
   ```
3. **In-App Device Export**:
   Alternatively, open the **Home-screen install** on your phone, go to **Settings** → **Backup & Export**, and tap **Export JSON** to save or share your complete workout and weight history via iOS Share Sheet (Files or iCloud Drive).
