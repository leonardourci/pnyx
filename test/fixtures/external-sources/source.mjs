import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, watch, writeFileSync } from 'node:fs'
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

if (mode === 'wait' || mode === 'wait-tree') {
  if (mode === 'wait-tree') {
    const descendantFolder = join(
      folder,
      'descendant',
    )
    mkdirSync(descendantFolder)
    const descendant = spawn(
      process.execPath,
      [
        process.argv[1],
        'wait',
        descendantFolder,
      ],
      {
        stdio: 'ignore',
      },
    )
    writeFileSync(
      join(
        folder,
        'descendant-pid',
      ),
      String(descendant.pid),
    )
  }

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
} else if (mode === 'unicode') {
  process.stdout.write('🌊'.repeat(4096))
} else if (mode === 'binary') {
  process.stdout.write(Buffer.alloc(
    16_384,
    0xff,
  ))
} else {
  process.stdout.write(payload)
  process.stderr.write('fixture diagnostic')
  process.exitCode = mode === 'fail' ? 7 : 0
}
