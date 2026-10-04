/* Break-glass passkey reset logic.
 *
 * Used when the owner loses all their passkeys/devices.
 * Refuses to run without explicit confirmation of the target host.
 * Deletes all passkeys for the profile, increments session_version (invalidating existing sessions),
 * and leaves profile and profile_data completely intact for Re-enrolment.
 */

export function extractHost(connectionString) {
  if (!connectionString || typeof connectionString !== 'string') return null
  try {
    const u = new URL(connectionString)
    return u.hostname || null
  } catch {
    return null
  }
}

export function verifyConfirmation(expectedHost, confirmedHost) {
  if (!expectedHost || typeof expectedHost !== 'string') return false
  if (!confirmedHost || typeof confirmedHost !== 'string') return false
  return expectedHost.trim().toLowerCase() === confirmedHost.trim().toLowerCase()
}

export async function resetPasskeys(db, { profileId } = {}) {
  let profileQuery = 'SELECT id, name, session_version FROM profiles'
  const params = []
  if (profileId) {
    profileQuery += ' WHERE id = $1'
    params.push(profileId)
  }
  const { rows: profiles } = await db.query(profileQuery, params)
  if (!profiles.length) {
    return { ok: false, reason: 'no_profiles', passkeysDeleted: 0, profilesReset: [] }
  }

  let totalDeleted = 0
  const profilesReset = []

  for (const p of profiles) {
    const { rows: countRows } = await db.query(
      'SELECT count(*)::int AS count FROM passkeys WHERE profile_id = $1',
      [p.id]
    )
    const count = countRows[0]?.count ?? 0
    await db.query('DELETE FROM passkeys WHERE profile_id = $1', [p.id])
    const { rows: updateRows } = await db.query(
      'UPDATE profiles SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version',
      [p.id]
    )
    totalDeleted += count
    profilesReset.push({
      id: p.id,
      name: p.name,
      previousSessionVersion: p.session_version,
      newSessionVersion: updateRows[0].session_version,
      passkeysDeleted: count
    })
  }

  return {
    ok: true,
    passkeysDeleted: totalDeleted,
    profilesReset
  }
}

export async function executeBreakGlass({
  connectionString,
  targetHost,
  confirmedHost,
  db,
  log = console.log
}) {
  const host = targetHost || extractHost(connectionString)
  if (!host) {
    throw new Error('Could not determine target database host.')
  }
  if (!verifyConfirmation(host, confirmedHost)) {
    throw new Error(`Refusing to run: confirmation "${confirmedHost || ''}" does not match target host "${host}".`)
  }

  log(`Confirmed target host: ${host}`)
  const result = await resetPasskeys(db)
  if (!result.ok && result.reason === 'no_profiles') {
    log('No profiles found in database. Nothing to reset.')
    return result
  }

  for (const p of result.profilesReset) {
    log(`Profile ${p.id} (${p.name}): deleted ${p.passkeysDeleted} passkey(s), session version bumped from ${p.previousSessionVersion} to ${p.newSessionVersion}.`)
  }
  log('Profile data was left untouched.')
  log('Re-enrolment is now available. Register with a valid setup code to attach a new passkey.')
  return result
}
