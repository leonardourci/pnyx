import { writeFileSync } from 'node:fs'
// A real server process with fake AI providers, so a checkout hook can kill it mid-handoff.
import { afterHandoffSync } from '../handoff-sync.ts'
import { startServer } from '#app/server-daemon.ts'
import { fakeClaude, fakeCodex } from '../agents.ts'

process.env.OTHRYS_HANDOFF_CRASH_PID = String(process.pid)
const crashAfterCommit = process.env.OTHRYS_CRASH_AFTER_COMMIT
const hydraId = process.env.OTHRYS_CRASH_TITAN

if (!hydraId) {
  throw new Error('OTHRYS_CRASH_TITAN is required')
}

if (crashAfterCommit) {
  const source = process.env.OTHRYS_CRASH_SOURCE
  const target = process.env.OTHRYS_CRASH_TARGET

  if (!source || !target || !process.env.OTHRYS_HOME) {
    throw new Error('The crash fixture needs both native task logs')
  }

  afterHandoffSync({
    home: process.env.OTHRYS_HOME,
    hydra: hydraId,
    source,
    target,
    cwd: crashAfterCommit,
    branch: 'iris/target-2',
    cut: process.env.OTHRYS_CRASH_SCOPE_CUT === 'first' ? 'first' : 'both',
    after: ({ first }) => {
      if (process.env.OTHRYS_CRASH_PROOF) {
        writeFileSync(
          process.env.OTHRYS_CRASH_PROOF,
          first,
        )
      }

      process.kill(
        process.pid,
        'SIGKILL',
      )
    },
  })
}

const claude = fakeClaude()
const codex = fakeCodex()
const server = await startServer({
  port: 0,
  query: claude.query,
  spawnCodex: codex.spawnCodex,
  queueDelay: 100,
  recoveryPause: 100,
})
await server.open({ id: hydraId })
process.send?.('ready')
