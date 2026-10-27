import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// test/ stays a root until every feature's tests sit beside their code.
const ROOTS = [
  'test',
  'src',
  'web/src',
  'scripts',
  'eslint',
  'e2e',
]

export function isScenario({ file }: { file: string }): boolean {
  return file.includes('test/scenarios/') || /\.(scenario|e2e)\.test\.ts$/.test(file)
}

// Every test file under the roots, relative to the repository and sorted.
export function discoverTests(): string[] {
  return ROOTS.filter(root => existsSync(root)).flatMap(root => readdirSync(
    root,
    { recursive: true },
  ).map(name => join(
    root,
    String(name),
  )))
    .filter(file => file.endsWith('.test.ts'))
    .sort()
}
