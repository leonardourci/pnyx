import { writeFileSync } from 'node:fs'
// A real server process with fake AI providers, so a checkout hook can kill it mid-handoff.
import { afterHandoffSync } from '../handoff-sync.ts'
import { startServer } from '#app/server-daemon.ts'
import { fakeClaude, fakeCodex } from '../agents.ts'

process.env.PNYX_HANDOFF_CRASH_PID = String(process.pid)
const crashAfterCommit = process.env.PNYX_CRASH_AFTER_COMMIT
const hydraId = process.env.PNYX_CRASH_HYDRA

if (!hydraId) {
  throw new Error('PNYX_CRASH_HYDRA is required')
}

if (crashAfterCommit) {
  const source = process.env.PNYX_CRASH_SOURCE
  const target = process.env.PNYX_CRASH_TARGET

  if (!source || !target || !process.env.PNYX_HOME) {
    throw new Error('The crash fixture needs both native task logs')
  }

  afterHandoffSync({
    home: process.env.PNYX_HOME,
    hydra: hydraId,
    source,
    target,
    cwd: crashAfterCommit,
    branch: 'iris/target-2',
    cut: process.env.PNYX_CRASH_SCOPE_CUT === 'first' ? 'first' : 'both',
    after: ({ first }) => {
      if (process.env.PNYX_CRASH_PROOF) {
        writeFileSync(
          process.env.PNYX_CRASH_PROOF,
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
