#!/usr/bin/env node
import { tryFastPath } from 'axi-sdk-js/fast-path'
import { installedVersion } from './version.ts'

// Commands that must work while the server is down, and help, run here; every other command runs in the server.
const LOCAL = new Set([
  'serve',
  'stop',
  'restart',
  'setup',
  'upgrade',
  'update',
])

const argv = process.argv.slice(2)

if (!tryFastPath(
  argv,
  // A getter, so only `--version` pays for asking git.
  {
    get version() {
      return installedVersion()
    },
  },
)) {
  // `setup hydra` writes Hydra events, so it goes to the server like any other write.
  const local = LOCAL.has(argv[0] ?? '') && !(argv[0] === 'setup' && argv[1] === 'hydra')

  if (local || argv.includes('--help') || argv[0]?.startsWith('-')) {
    await import('./main.ts')
  } else {
    const { forward } = await import('./client.ts')
    await forward({ argv })
  }
}
