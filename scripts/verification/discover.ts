import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// Tests sit beside the code they cover, so the launcher looks through every source root.
const ROOTS = [
  'test',
  'src',
  'web/src',
  'scripts',
  'eslint',
  'e2e',
]
const FLOW_FOLDERS = [
  'test/scenarios/',
  'e2e/',
]

// Flows share one server in one process; everything else runs file by file.
export function isFlow({ file }: { file: string }): boolean {
  const path = relative(
    process.cwd(),
    resolve(file),
  )

  return FLOW_FOLDERS.some(folder => path.startsWith(folder))
}

function walk({ folder }: { folder: string }): string[] {
  let entries

  try {
    entries = readdirSync(
      folder,
      { withFileTypes: true },
    )
  } catch {
    return []
  }

  return entries.flatMap(entry => {
    const path = join(
      folder,
      entry.name,
    )

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'fixtures' ? [] : walk({ folder: path })
    }

    return entry.name.endsWith('.test.ts') ? [path] : []
  })
}

export function discover({ lane }: { lane: 'unit' | 'scenarios' }): string[] {
  return ROOTS.flatMap(folder => walk({ folder }))
    .filter(file => isFlow({ file }) === (lane === 'scenarios'))
    .sort()
}
