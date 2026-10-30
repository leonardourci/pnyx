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
  const stop = () => host.close().catch(() => {
    process.exitCode = 1
  })
  process.once(
    'SIGTERM',
    stop,
  )
  process.once(
    'SIGINT',
    stop,
  )
} catch (error) {
  const result = errorResult({ error })
  process.stderr.write(`${result.code}: ${result.message}\n`)
  process.exitCode = 1
}
