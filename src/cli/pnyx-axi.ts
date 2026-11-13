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
// The upgrade to stop runs in the server; with none up, the command answers here that nothing is running.
const upgradeStop = argv[0] === 'upgrade' && argv.includes('--stop')

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
  const own = LOCAL.has(argv[0] ?? '') && !(argv[0] === 'setup' && argv[1] === 'hydra') && !upgradeStop
  const local = own || argv.includes('--help') || argv[0]?.startsWith('-')
  const client = local ? undefined : await import('./client.ts')

  if (!client || (upgradeStop && !client.serverRunning())) {
    await import('./main.ts')
  } else {
    await client.forward({ argv })
  }
}
