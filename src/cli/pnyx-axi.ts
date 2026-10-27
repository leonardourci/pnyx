#!/usr/bin/env node
import { tryFastPath } from 'axi-sdk-js/fast-path'
import { version } from './version.ts'

if (!tryFastPath(
  process.argv.slice(2),
  { version },
)) {
  await import('./main.ts')
}
