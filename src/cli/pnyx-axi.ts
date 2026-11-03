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

// Repairs a log the server cannot load, so it also runs here when no server is up: a torn log can be what stops one.
const OFFLINE = new Set(['repair'])

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
  const local = LOCAL.has(argv[0] ?? '') || argv.includes('--help') || argv[0]?.startsWith('-')
  const client = local ? undefined : await import('./client.ts')

  if (!client || (OFFLINE.has(argv[0] ?? '') && !client.serverRunning())) {
    await import('./main.ts')
  } else {
    await client.forward({ argv })
  }
}
