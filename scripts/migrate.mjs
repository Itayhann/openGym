// Applies database migrations. Run against production with the *unpooled* connection string:
//   vercel env pull .env.local        (writes DATABASE_URL_UNPOOLED among others)
//   npm run migrate
// Reads .env.local if present; DATABASE_URL_UNPOOLED wins over DATABASE_URL.
import { connect, describeTarget } from '../server/db.js'
import { migrate } from '../server/migrate.js'

try { process.loadEnvFile('.env.local') } catch { /* no .env.local: use the real environment */ }
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
if (!url) { console.error('Set DATABASE_URL_UNPOOLED (or DATABASE_URL), e.g. via `vercel env pull .env.local`.'); process.exit(1) }

const db = connect(url, { max: 1 })
try {
  console.log(`migrating ${describeTarget(url)}`)
  const applied = await migrate(db, { log: m => console.log(' ', m) })
  console.log(applied.length ? `done: ${applied.length} applied` : 'already up to date')
} catch (e) {
  console.error(e.message); process.exitCode = 1
} finally {
  await db.end()
}
