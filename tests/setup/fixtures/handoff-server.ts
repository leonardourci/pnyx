import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'
import { execFileSync } from 'node:child_process'
// A real server process with fake AI providers, so a checkout hook can kill it mid-handoff.
import { startServer } from '#app/server-daemon.ts'
import { fakeClaude, fakeCodex } from '../agents.ts'

process.env.PNYX_HANDOFF_CRASH_PID = String(process.pid)
const crashAfterCommit = process.env.PNYX_CRASH_AFTER_COMMIT
const hydraId = process.env.PNYX_CRASH_HYDRA

if (!hydraId) {
  throw new Error('PNYX_CRASH_HYDRA is required')
}

if (crashAfterCommit) {
  const receive = workerThreads.receiveMessageOnPort

  // eslint-disable-next-line pnyx/object-params -- Node owns this transport signature.
  workerThreads.receiveMessageOnPort = port => {
    const reply = receive(port)

    if (reply && !reply.message.error && reply.message.results?.length > 1
      && execFileSync(
        'git',
        [
          '-C',
          crashAfterCommit,
          'branch',
          '--show-current',
        ],
        { encoding: 'utf8' },
      ).trim() === 'iris/target-2') {
      process.kill(
        process.pid,
        'SIGKILL',
      )
    }

    return reply
  }

  syncBuiltinESMExports()
}

const claude = fakeClaude()
const codex = fakeCodex()
const server = await startServer({
  port: 0,
  query: claude.query,
  spawnCodex: codex.spawnCodex,
  recoveryPause: 100,
})
await server.open({ id: hydraId })
process.send?.('ready')
