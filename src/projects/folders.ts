import { opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { hydraIds, loadHydra } from '../store/hydra-store.ts'

export interface Folder { name: string; path: string }
export interface FolderListing {
  folders: Folder[]
  recent: Folder[]
  selected?: Folder & { empty: boolean }
  cloneInto?: string
}

const folder = ({ path }: { path: string }): Folder => ({ name: basename(path) || path, path })

async function emptyFolder({ path }: { path: string }): Promise<boolean> {
  const entries = await opendir(path)

  try {
    return await entries.read() === null
  } finally {
    await entries.close()
  }
}

export async function listFolders({ path, repository = '', home = homedir() }: {
  path: string
  repository?: string
  home?: string
}): Promise<FolderListing> {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path

  if (expanded && !isAbsolute(expanded)) {
    throw new Error('Enter an absolute laptop folder path, or start with ~/')
  }

  const typed = expanded ? resolve(expanded) : home
  let selected: FolderListing['selected']

  try {
    if ((await stat(typed)).isDirectory()) {
      selected = {
        ...folder({ path: await realpath(typed) }),
        empty: await emptyFolder({ path: typed }),
      }
    }
  } catch { /* Missing prefixes still complete from their parent. */ }

  const root = selected ? typed : dirname(typed)
  const prefix = selected ? '' : basename(typed).toLowerCase()
  const folders: Folder[] = []
  const entries = await opendir(root)

  for await (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(prefix) || (entry.name.startsWith('.') && !prefix.startsWith('.'))) {
      continue
    }

    const child = join(root, entry.name)

    const directory = entry.isDirectory()
      || (entry.isSymbolicLink() && await stat(child).then(s => s.isDirectory(), () => false))

    if (directory) {
      folders.push(folder({ path: child }))
    }

    if (folders.length === 50) {
      break
    }
  }

  const seen = new Set<string>()
  const candidates: string[] = []

  for (const hydraId of hydraIds()) {
    try {
      const { state } = loadHydra({ hydraId })

      for (const card of Object.values(state.cards).sort((a, b) => b.updatedSeq - a.updatedSeq)) {
        const cwd = card.agent?.cwd

        const matches = !expanded || cwd?.toLowerCase().startsWith(expanded.toLowerCase())

        if (cwd && !seen.has(cwd) && matches) {
          seen.add(cwd); candidates.push(cwd)
        }
      }
    } catch { /* An unreadable Hydra does not hide the others' history. */ }
  }

  const recent: Folder[] = []

  for (const cwd of candidates) {
    try {
      if ((await stat(cwd)).isDirectory()) {
        recent.push(folder({ path: await realpath(cwd) }))
      }
    } catch { /* Old working folders can have disappeared. */ }

    if (recent.length === 8) {
      break
    }
  }

  const name = repository.trim().replace(/[\\/]+$/, '')
    .split(/[/:]/)
    .at(-1)
    ?.replace(/\.git$/, '')
  const cloneInto = repository.trim() && expanded && name && name !== '.' && name !== '..' && !/[?#]/.test(name)
    ? selected ? selected.empty ? selected.path : join(selected.path, name) : typed : undefined

  return {
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
    recent,
    ...(selected ? { selected } : {}),
    ...(cloneInto ? { cloneInto } : {}),
  }
}
