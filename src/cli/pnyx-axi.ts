#!/usr/bin/env node
import { tryFastPath } from 'axi-sdk-js/fast-path'
import { installedVersion } from './version.ts'

if (!tryFastPath(
  process.argv.slice(2),
  // A getter, so only `--version` pays for asking git.
  {
    get version() {
      return installedVersion()
    },
  },
)) {
  await import('./main.ts')
}
