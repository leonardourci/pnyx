import { existsSync, writeFileSync } from 'node:fs'

if (process.argv[2] === 'serve' && process.env.PNYX_TEST_SLOW_SERVE
  && (!process.env.PNYX_TEST_SLOW_ARM || existsSync(process.env.PNYX_TEST_SLOW_ARM))) {
  writeFileSync(
    process.env.PNYX_TEST_SLOW_SERVE,
    String(process.pid),
  )
  process.kill(
    process.pid,
    'SIGSTOP',
  )
}
