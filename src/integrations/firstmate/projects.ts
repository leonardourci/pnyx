import { readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { HydraProject } from '#projects/model.ts'

export function firstmateProjects({
  home,
  aliases = false,
}: {
  home: string
  aliases?: boolean
}): (HydraProject & { aliases?: string[] })[] {
  const ownHome = process.env.FM_HOME && resolve(process.env.FM_HOME) === resolve(home)
  const root = ownHome && process.env.FM_PROJECTS_OVERRIDE
    ? process.env.FM_PROJECTS_OVERRIDE : join(
      home,
      'projects',
    )
  let names: string[]

  try {
    names = readdirSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }

    return []
  }

  const projects = new Map<string, HydraProject & { aliases?: string[] }>()

  for (const name of names.sort()) {
    try {
      const path = realpathSync(join(
        root,
        name,
      ))

      if (statSync(path).isDirectory()) {
        projects.set(
          path,
          {
            path,
            name: basename(path),
            detached: false,
            ...(aliases ? {
              aliases: [
                ...projects.get(path)?.aliases ?? [],
                name,
              ],
            } : {}),
          },
        )
      }
    } catch (error) {
      if (![
        'ENOENT',
        'ENOTDIR',
      ].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error
      }
    }
  }

  return [...projects.values()]
}
