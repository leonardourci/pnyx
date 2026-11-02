import { replayCodex } from '#test-harness/fake-agents.ts'

const replay = replayCodex({ hydra: () => process.env.PNYX_HYDRA ?? '' })
const child = replay.spawnCodex({
  cwd: process.cwd(),
  env: process.env,
})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
process.stdin.on(
  'end',
  () => child.kill(),
)
