import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { object } from './transcript-usage.ts'

export async function projectFolders({ cwd }: { cwd: string }): Promise<string[]> {
  const folders = [cwd]

  for (let here = cwd, depth = 0; depth < 40; depth++) {
    try {
      await stat(join(
        here,
        '.git',
      ))

      return folders
    } catch { /* Worktrees use a .git file. */ }

    const parent = dirname(here)

    if (parent === here) {
      break
    }

    folders.push(parent)
    here = parent
  }

  return [cwd]
}

export function pluginInstallation({
  value,
  folders,
}: {
  value: unknown
  folders: string[]
}): string | undefined {
  const configured = Array.isArray(value) ? value : []
  const entries = configured.map(value => object({ value })).filter(entry =>
    typeof entry.installPath === 'string' && isAbsolute(entry.installPath)
    && (entry.scope === 'user' || ((entry.scope === 'project' || entry.scope === 'local')
      && typeof entry.projectPath === 'string' && folders.includes(resolve(entry.projectPath)))))
  const installation = entries.find(entry => entry.scope === 'local')
    ?? entries.find(entry => entry.scope === 'project') ?? entries[0]

  return installation?.installPath as string | undefined
}
