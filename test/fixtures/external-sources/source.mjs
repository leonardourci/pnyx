import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [
  mode,
  folder,
  payload = 'result',
] = process.argv.slice(2)
appendFileSync(
  join(
    folder,
    'launches',
  ),
  `${process.pid}\n`,
)

if (mode === 'wait') {
  process.stdout.write('listening\n')

  const finish = () => {
    if (existsSync(join(
      folder,
      'release',
    ))) {
      process.stdout.write(payload)
      process.exit(0)
    }
  }

  watch(
    folder,
    finish,
  )
  writeFileSync(
    join(
      folder,
      'ready',
    ),
    String(process.pid),
  )
  finish()
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(16_384))
} else {
  process.stdout.write(payload)
  process.stderr.write('fixture diagnostic')
  process.exitCode = mode === 'fail' ? 7 : 0
}
