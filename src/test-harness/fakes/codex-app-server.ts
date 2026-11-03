import { replayCodex } from '#test-harness/fake-agents.ts'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const replay = replayCodex({ hydra: () => process.env.PNYX_HYDRA ?? '' })
const child = replay.spawnCodex({
  cwd: process.cwd(),
  env: process.env,
})
process.stdin.pipe(child.stdin)
const releaseFile = process.env.FAKE_CODEX_RELEASE_FILE

if (releaseFile) {
  createInterface({ input: child.stdout }).on(
    'line',
    async line => {
      if (JSON.parse(line).method === 'turn/completed') {
        const deadline = Date.now() + 120_000

        while (!existsSync(releaseFile) && Date.now() < deadline) {
          await delay(100)
        }
      }

      process.stdout.write(`${line}\n`)
    },
  )
} else {
  child.stdout.pipe(process.stdout)
}

child.stderr.pipe(process.stderr)
process.stdin.on(
  'end',
  () => child.kill(),
)
