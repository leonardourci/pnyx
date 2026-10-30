import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processStart } from '#agent-host/discovery.ts'

process.on(
  'SIGTERM',
  () => {},
)

const [
  directory,
  role,
] = process.argv.slice(2)

if (role === 'tool') {
  setInterval(
    () => {},
    1000,
  )
} else {
  const tool = spawn(
    process.execPath,
    [
      '--conditions=source',
      import.meta.filename,
      directory,
      'tool',
    ],
    { stdio: 'ignore' },
  )
  const pid = process.pid
  writeFileSync(
    join(
      directory,
      'owned-tree.json',
    ),
    JSON.stringify({
      parent: {
        pid,
        start: processStart({ pid }),
      },
      tool: {
        pid: tool.pid,
        start: processStart({ pid: tool.pid! }),
      },
    }),
  )
  setInterval(
    () => {},
    1000,
  )
}
