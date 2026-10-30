import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProvider } from '#workers/claude.ts'
import { codexProvider } from '#workers/codex.ts'
import { validateBundle } from './bundle.ts'
import { serveAgentHost } from './server.ts'
import { errorResult, fail } from './protocol.ts'

const [
  bundle,
  directory,
  installation,
  ...extra
] = process.argv.slice(2)

process.once(
  'exit',
  code => process.stderr.write(`${new Date().toISOString()} Native host ${process.pid} exit code=${code}\n`),
)

try {
  if (!bundle || !directory || !installation || extra.length) {
    fail({
      code: 'USAGE',
      message: 'native-host <immutable-bundle> <private-runtime-directory> <installation-id>',
    })
  }

  const manifest = validateBundle({ directory: bundle })

  if (realpathSync(fileURLToPath(import.meta.url)) !== realpathSync(join(
    bundle,
    manifest.entry,
  ))) {
    fail({
      code: 'INVALID_BUNDLE',
      message: 'Run the native host entry from its verified immutable bundle',
    })
  }

  const host = await serveAgentHost({
    directory,
    installation,
    build: manifest.build,
    providers: {
      'claude-code': claudeProvider({}),
      codex: codexProvider({}),
    },
  })
  process.stderr.write(`${new Date().toISOString()} Native host ${process.pid} ready\n`)

  const stop = ({ signal }: { signal: NodeJS.Signals }) => {
    process.stderr.write(`${new Date().toISOString()} Native host ${process.pid} received ${signal}\n`)
    host.close().catch(error => {
      process.stderr.write(`Native host close failed: ${String(error)}\n`)
      process.exitCode = 1
    })
  }

  process.once(
    'SIGTERM',
    () => stop({ signal: 'SIGTERM' }),
  )
  process.once(
    'SIGINT',
    () => stop({ signal: 'SIGINT' }),
  )
  await host.closed
  process.stderr.write(`${new Date().toISOString()} Native host ${process.pid} closed\n`)
} catch (error) {
  const result = errorResult({ error })
  process.stderr.write(`${result.code}: ${result.message}\n`)
  process.exitCode = 1
}
