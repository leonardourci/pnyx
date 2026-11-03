import { renameSync, writeFileSync } from 'node:fs'

if (process.argv[2] === 'serve' && process.env.PNYX_TEST_SLOW_SERVE) {
  const marker = process.env.PNYX_TEST_SLOW_SERVE
  const pending = `${marker}.${process.pid}.tmp`
  writeFileSync(
    pending,
    String(process.pid),
  )
  renameSync(
    pending,
    marker,
  )
  process.kill(
    process.pid,
    'SIGSTOP',
  )
}
