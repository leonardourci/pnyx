import { open, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { Card } from '../core/model.ts'

export interface Suggestion { command: string; description: string; source: string }
export interface Catalog { suggestions: Suggestion[]; unavailable?: string; note?: string }
export interface CatalogLocations { home: string; claude: string; codex: string }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const nameOK = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(v)

const within = (root: string, path: string) => {
  const part = relative(root, path)

  return part !== '..' && !part.startsWith('../') && !isAbsolute(part)
}

const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

// Only metadata is returned. File contents are never expanded or executed.
// Budgets also bound symlink cycles and unusually large installations.
class Reader {
  remaining = 1000
  partial = false
  async text(path: string): Promise<string | undefined> {
    if (--this.remaining < 0) {
      this.partial = true

      return
    }

    let file

    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
      const info = await file.stat()

      if (!info.isFile() || info.size > 65_536) {
        this.partial = true

        return
      }

      const bytes = Buffer.alloc(Math.min(info.size, 65_536))
      const read = await file.read(bytes, 0, bytes.length, 0)

      return bytes.subarray(0, read.bytesRead).toString('utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.partial = true
      }
    } finally {
      await file?.close()
    }
  }

  async json(path: string) {
    const text = await this.text(path)

    if (!text) {
      return {}
    }

    try {
      return object(JSON.parse(text))
    } catch {
      this.partial = true

      return {}
    }
  }

  async list(path: string): Promise<string[]> {
    if (--this.remaining < 0) {
      this.partial = true

      return []
    }

    try {
      const names = (await readdir(path)).sort(sort)

      if (names.length > 500) {
        this.partial = true
      }

      return names.slice(0, 500)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.partial = true
      }

      return []
    }
  }

  async metadata(path: string) {
    const text = await this.text(path)

    if (text === undefined) {
      return
    }

    if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
      return {}
    }

    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)

    if (!match) {
      this.partial = true

      return
    }

    try {
      const doc = parseDocument(match[1], { logLevel: 'silent', uniqueKeys: true })

      if (doc.errors.length) {
        throw new Error('invalid metadata')
      }

      return object(doc.toJS({ maxAliasCount: 0 }))
    } catch {
      this.partial = true
    }
  }
}

async function projectFolders(cwd: string): Promise<string[]> {
  const folders = [cwd]

  for (let here = cwd, depth = 0; depth < 40; depth++) {
    try {
      await stat(join(here, '.git'))

      return folders
    } catch { /* Worktrees use a .git file. */ }

    const parent = dirname(here)

    if (parent === here) {
      break
    }

    folders.push(parent); here = parent
  }

  // Outside a repository, unrelated ancestor folders are not project scopes.
  return [cwd]
}

export async function readCatalog(card: Card, locations: CatalogLocations = {
  home: homedir(), claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
}): Promise<Catalog> {
  if (!card.agent?.cwd || !isAbsolute(card.agent.cwd)) {
    return { suggestions: [], unavailable: 'No working folder is recorded for this session. Commands stay literal.' }
  }

  const provider = card.agent.provider

  if (!['claude', 'claude-code', 'codex'].includes(provider)) {
    return { suggestions: [], unavailable: 'This harness has no supported local catalog. Commands stay literal.' }
  }

  let cwd: string

  try {
    cwd = await realpath(card.agent.cwd)

    if (!(await stat(cwd)).isDirectory()) {
      throw new Error('not a folder')
    }
  } catch {
    return { suggestions: [], unavailable: 'The session working folder is unavailable. Commands stay literal.' }
  }

  const reader = new Reader()
  const folders = await projectFolders(cwd)
  const suggestions = new Map<string, Suggestion>()

  const add = (command: string, meta: Record<string, unknown>, source: string) => {
    if (meta['user-invocable'] === false || suggestions.has(command)) {
      return
    }

    if (suggestions.size >= 200) {
      reader.partial = true

      return
    }

    suggestions.set(command, { command, source, description: typeof meta.description === 'string' ? meta.description.slice(0, 240) : 'Local harness command' })
  }

  const skills = async (
    root: string,
    source: string,
    prefix: string,
    disabled: Record<string, unknown> = {},
  ) => {
    for (const entry of await reader.list(root)) {
      if (entry.startsWith('.')) {
        continue
      }

      const meta = await reader.metadata(join(root, entry, 'SKILL.md'))

      if (!meta) {
        continue
      }

      const name = meta.name ?? entry

      if (nameOK(name) && disabled[name] !== 'off') {
        add(prefix + name, meta, source)
      }
    }
  }

  const commands = async (
    root: string,
    source: string,
    prefix: string,
    recursive: boolean,
    depth = 0,
    seen = new Set<string>(),
  ) => {
    if (depth > 6) {
      reader.partial = true

      return
    }

    let actual: string

    try {
      actual = await realpath(root)
    } catch {
      return
    }

    if (seen.has(actual)) {
      return
    }

    seen.add(actual)

    for (const entry of await reader.list(root)) {
      if (entry.startsWith('.')) {
        continue
      }

      const path = join(root, entry)

      if (entry.endsWith('.md')) {
        const name = basename(entry, '.md'), meta = await reader.metadata(path)

        if (nameOK(name) && meta) {
          add(prefix + name, meta, source)
        }
      } else if (recursive) {
        try {
          if ((await stat(path)).isDirectory()) {
            await commands(path, source, prefix, true, depth + 1, seen)
          }
        } catch { /* Gone during discovery. */ }
      }
    }
  }

  if (provider === 'codex') {
    for (const folder of folders) {
      await skills(join(folder, '.agents/skills'), 'Project skill', '$')
    }

    await skills(join(locations.home, '.agents/skills'), 'Personal skill', '$')
    await commands(join(locations.codex, 'prompts'), 'Personal prompt', '/prompts:', false)
  } else {
    const settings = [await reader.json(join(locations.claude, 'settings.json'))]

    for (const folder of [...folders].reverse()) {
      for (const file of ['settings.json', 'settings.local.json']) {
        settings.push(await reader.json(join(folder, '.claude', file)))
      }
    }

    const enabled = Object.assign(
      {},
      ...settings.map(s => object(s.enabledPlugins)),
    ) as Record<string, unknown>
    const overrides = Object.assign(
      {},
      ...settings.map(s => object(s.skillOverrides)),
    ) as Record<string, unknown>
    await skills(join(locations.claude, 'skills'), 'Personal skill', '/', overrides)

    for (const folder of folders) {
      await skills(join(folder, '.claude/skills'), 'Project skill', '/', overrides)
    }

    for (const folder of folders) {
      await commands(join(folder, '.claude/commands'), 'Project command', '/', true)
    }

    await commands(join(locations.claude, 'commands'), 'Personal command', '/', true)
    const installed = await reader.json(join(locations.claude, 'plugins/installed_plugins.json'))

    const plugins = Object.entries(object(installed.plugins)).sort(([a], [b]) => sort(a, b))

    for (const [id, raw] of plugins) {
      if (enabled[id] !== true || !Array.isArray(raw)) {
        continue
      }

      // Most specific applicable installation wins; never enumerate plugin caches.
      const entries = raw.map(object).filter(e => typeof e.installPath === 'string' && isAbsolute(e.installPath) && (e.scope === 'user' || ((e.scope === 'project' || e.scope === 'local') && typeof e.projectPath === 'string' && folders.includes(resolve(e.projectPath)))))
        .sort((a, b) => String(b.scope).localeCompare(String(a.scope)))
      const installation = entries.find(e => e.scope === 'local') ?? entries.find(e => e.scope === 'project') ?? entries[0]

      if (!installation) {
        continue
      }

      const root = installation.installPath as string, manifest = await reader.json(join(root, '.claude-plugin/plugin.json'))
      const namespace = manifest.name ?? id.split('@')[0]

      if (!nameOK(namespace)) {
        continue
      }

      const paths = (field: string) => [field, ...(typeof manifest[field] === 'string' ? [manifest[field]] : Array.isArray(manifest[field]) ? manifest[field] : [])].filter((p): p is string => typeof p === 'string').map(p => resolve(root, p))
        .filter(p => within(root, p))

      for (const path of [...new Set(paths('skills'))]) {
        await skills(path, `Plugin ${namespace}`, `/${namespace}:`)
      }

      for (const path of [...new Set(paths('commands'))]) {
        if (path.endsWith('.md')) {
          const meta = await reader.metadata(path), name = basename(path, '.md')

          if (meta && nameOK(name)) {
            add(`/${namespace}:${name}`, meta, `Plugin ${namespace}`)
          }
        } else {
          await commands(path, `Plugin ${namespace}`, `/${namespace}:`, true)
        }
      }
    }
  }

  return { suggestions: [...suggestions.values()].sort((a, b) => sort(a.command, b.command)), note: reader.partial ? 'Some local catalog files could not be read or exceeded the discovery limit.' : 'Local files; the harness may require a reload or have additional availability rules. Inserted text stays literal.' }
}
