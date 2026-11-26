import { opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { hydraIds, hydrasDir } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { CONTENTS_LIMIT, RECENT_LIMIT } from './folder-limit.ts'
import { hiddenUntilDotTyped, startsWithTyped } from './folder-names.ts'

const FOLDER_LIMIT = 50

export interface FolderEntry {
  name: string
  path: string
}
export interface FolderListing {
  folders: FolderEntry[]
  files?: FolderEntry[]
  recent: FolderEntry[]
  selected?: FolderEntry & { empty: boolean }
  cloneInto?: string
}

const folderEntry = ({ path }: { path: string }): FolderEntry => ({
  name: basename(path) || path,
  path,
})

async function emptyFolder({ path }: { path: string }): Promise<boolean> {
  const entries = await opendir(path)

  try {
    return await entries.read() === null
  } finally {
    await entries.close()
  }
}

export async function listFolders({
  path,
  repository = '',
  home = homedir(),
  withFiles = false,
}: {
  path: string
  repository?: string
  home?: string
  withFiles?: boolean
}): Promise<FolderListing> {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(
    home,
    path.slice(2),
  ) : path

  if (expanded && !isAbsolute(expanded)) {
    throw new Error('Enter an absolute laptop folder path, or start with ~/')
  }

  const typed = expanded ? resolve(expanded) : home
  let selected: FolderListing['selected']

  try {
    if ((await stat(typed)).isDirectory()) {
      selected = {
        ...folderEntry({ path: await realpath(typed) }),
        empty: await emptyFolder({ path: typed }),
      }
    }
  } catch { /* Missing prefixes still complete from their parent. */ }

  const root = selected ? typed : dirname(typed)
  const prefix = selected ? '' : basename(typed)
  const folders: FolderEntry[] = []
  const files: FolderEntry[] = []
  const entryLimit = withFiles ? CONTENTS_LIMIT : FOLDER_LIMIT
  const recentLimit = withFiles ? CONTENTS_LIMIT : RECENT_LIMIT
  const entries = await opendir(root)

  for await (const entry of entries) {
    const named = startsWithTyped({
      name: entry.name,
      typed: prefix,
    })
    const hidden = !withFiles && hiddenUntilDotTyped({
      name: entry.name,
      typed: prefix,
    })

    if (!named || hidden) {
      continue
    }

    const child = join(
      root,
      entry.name,
    )

    const directory = entry.isDirectory()
      || (entry.isSymbolicLink() && await stat(child).then(
        s => s.isDirectory(),
        () => false,
      ))

    if (directory) {
      folders.push(folderEntry({ path: child }))
    } else if (withFiles && files.length < entryLimit) {
      files.push(folderEntry({ path: child }))
    }

    if (folders.length === entryLimit) {
      break
    }
  }

  const seen = new Set<string>()
  const candidates: string[] = []

  for (const titanId of hydraIds()) {
    try {
      const { state } = loadTitan({ titanId })

      for (const card of Object.values(state.cards).sort((
        a,
        b,
      ) => b.updatedSeq - a.updatedSeq)) {
        const cwd = card.agent?.cwd

        const matches = !expanded || cwd?.toLowerCase().startsWith(expanded.toLowerCase())

        if (cwd && !seen.has(cwd) && matches) {
          seen.add(cwd); candidates.push(cwd)
        }
      }
    } catch { /* An unreadable Titan does not hide the others' history. */ }
  }

  const recent: FolderEntry[] = []
  // Titan's own agent folders live under Othrys's home; they are never a project to add.
  const othrysFolders = await realpath(hydrasDir()).catch(() => hydrasDir())

  for (const cwd of candidates) {
    try {
      const path = await realpath(cwd)

      if ((await stat(path)).isDirectory() && !path.startsWith(`${othrysFolders}${sep}`)) {
        recent.push(folderEntry({ path }))
      }
    } catch { /* Old working folders can have disappeared. */ }

    if (recent.length === recentLimit) {
      break
    }
  }

  const name = repository.trim().replace(
    /[\\/]+$/,
    '',
  )
    .split(/[/:]/)
    .at(-1)
    ?.replace(
      /\.git$/,
      '',
    )
  const cloneInto = repository.trim() && expanded && name && name !== '.' && name !== '..' && !/[?#]/.test(name)
    ? selected ? selected.empty ? selected.path : join(
      selected.path,
      name,
    ) : typed : undefined

  return {
    folders: folders.sort((
      a,
      b,
    ) => a.name.localeCompare(b.name)),
    files: withFiles ? files.sort((
      a,
      b,
    ) => a.name.localeCompare(b.name)) : undefined,
    recent,
    ...(selected ? { selected } : {}),
    ...(cloneInto ? { cloneInto } : {}),
  }
}
