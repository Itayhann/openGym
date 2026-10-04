// Break-glass passkey reset script.
// Run on the owner's machine with the unpooled connection string:
//   vercel env pull .env.local
//   npm run break-glass
// Or:
//   node scripts/break-glass-reset.mjs [--confirm <host>]
import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import { connect, describeTarget } from '../server/db.js'
import { loadLocalEnv } from '../server/runtime.js'
import { extractHost, executeBreakGlass } from '../server/break-glass.js'

function promptQuestion(query) {
  const rl = readline.createInterface({ input, output })
  return new Promise(resolve => {
    let resolved = false
    rl.question(query, answer => {
      if (!resolved) {
        resolved = true
        rl.close()
        resolve(answer)
      }
    })
    rl.on('close', () => {
      if (!resolved) {
        resolved = true
        resolve('')
      }
    })
  })
}

export function parseArgs(args = process.argv.slice(2)) {
  let confirmHost = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm' && i + 1 < args.length) {
      confirmHost = args[i + 1]
      i++
    } else if (args[i].startsWith('--confirm=')) {
      confirmHost = args[i].slice('--confirm='.length)
    }
  }
  return { confirmHost }
}

export async function main() {
  loadLocalEnv()
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
  if (!url) {
    console.error('Set DATABASE_URL_UNPOOLED (or DATABASE_URL), e.g. via `vercel env pull .env.local`.')
    process.exit(1)
  }

  const targetHost = extractHost(url)
  if (!targetHost) {
    console.error(`Could not parse hostname from connection string (${describeTarget(url)}).`)
    process.exit(1)
  }

  const { confirmHost } = parseArgs()

  console.log('=== BREAK-GLASS PASSKEY RESET ===')
  console.log(`Database target: ${describeTarget(url)}`)
  console.log(`Target host:     ${targetHost}`)
  console.log('')
  console.log('WARNING: This will delete ALL passkeys and invalidate all active sessions.')
  console.log('Profile data and workout history will NOT be deleted.')
  console.log('You can then re-enrol using your SETUP_CODE.')
  console.log('')

  let confirmed = confirmHost
  if (!confirmed) {
    confirmed = await promptQuestion(`Type the target host ("${targetHost}") to confirm: `)
  }

  const db = connect(url, { max: 1 })
  try {
    await executeBreakGlass({
      connectionString: url,
      targetHost,
      confirmedHost: confirmed,
      db,
      log: console.log
    })
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  } finally {
    await db.end()
  }
}

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Run directly if invoked as main module
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
