import { open, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { HydraProject } from '#projects/model.ts'
import type { Card } from '#tasks/model.ts'

export interface Suggestion {
  command: string
  description: string
  source: string
  kind?: 'skill' | 'command'
  file?: string
  project?: string
  projectPath?: string
  unavailable?: string
}
export interface Catalog {
  suggestions: Suggestion[]
  unavailable?: string
  note?: string

}
export interface CatalogLocations {
  home: string
  claude: string
  codex: string
}
const object = ({ value: v }: { value: unknown }): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const validName = ({ value }: { value: unknown }): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value) ? value : undefined

const within = ({
  root,
  path,
}: {
  root: string
  path: string
}) => {
  const part = relative(
    root,
    path,
  )

  return part !== '..' && !part.startsWith('../') && !isAbsolute(part)
}

const sort = ({
  a,
  b,
}: {
  a: string
  b: string
}) => a < b ? -1 : a > b ? 1 : 0

// Only metadata is returned. File contents are never expanded or executed.
// Budgets also bound symlink cycles and unusually large installations.
class Reader {
  remaining = 1000
  partial = false
  observe?: ({ path }: { path: string }) => void
  async text({ path }: { path: string }): Promise<string | undefined> {
    this.observe?.({ path })

    if (--this.remaining < 0) {
      this.partial = true

      return
    }

    let file

    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      )
      const info = await file.stat()

      if (!info.isFile() || info.size > 65_536) {
        this.partial = true

        return
      }

      const bytes = Buffer.alloc(Math.min(
        info.size,
        65_536,
      ))
      const read = await file.read(
        bytes,
        0,
        bytes.length,
        0,
      )

      return bytes.subarray(
        0,
        read.bytesRead,
      ).toString('utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.partial = true
      }
    } finally {
      await file?.close()
    }
  }

  async json({ path }: { path: string }) {
    const text = await this.text({ path })

    if (!text) {
      return {}
    }

    try {
      return object({ value: JSON.parse(text) })
    } catch {
      this.partial = true

      return {}
    }
  }

  async list({ path }: { path: string }): Promise<string[]> {
    this.observe?.({ path })

    if (--this.remaining < 0) {
      this.partial = true

      return []
    }

    try {
      const names = (await readdir(path)).sort((
        a,
        b,
      ) => sort({
        a,
        b,
      }))

      if (names.length > 500) {
        this.partial = true
      }

      return names.slice(
        0,
        500,
      )
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.partial = true
      }

      return []
    }
  }

  async metadata({ path }: { path: string }) {
    const text = await this.text({ path })

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
      const doc = parseDocument(
        match[1],
        {
          logLevel: 'silent',
          uniqueKeys: true,
        },
      )

      if (doc.errors.length) {
        throw new Error('invalid metadata')
      }

      return object({ value: doc.toJS({ maxAliasCount: 0 }) })
    } catch {
      this.partial = true
    }
  }
}

async function projectFolders({ cwd }: { cwd: string }): Promise<string[]> {
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

    folders.push(parent); here = parent
  }

  // Outside a repository, unrelated ancestor folders are not project scopes.
  return [cwd]
}

export async function readCatalog({
  card,
  projects = [],
  observe,
  locations = {
    home: homedir(),
    claude: process.env.CLAUDE_CONFIG_DIR || join(
      homedir(),
      '.claude',
    ),
    codex: process.env.CODEX_HOME || join(
      homedir(),
      '.codex',
    ),
  },
}: {
  card: Card
  projects?: HydraProject[]
  observe?: ({ path }: { path: string }) => void
  locations?: CatalogLocations
}): Promise<Catalog> {
  if (!card.agent?.cwd || !isAbsolute(card.agent.cwd)) {
    return {
      suggestions: [],
      unavailable: 'No working folder is recorded for this session. Commands stay literal.',
    }
  }

  const provider = card.agent.provider

  if (![
    'claude',
    'claude-code',
    'codex',
  ].includes(provider)) {
    return {
      suggestions: [],
      unavailable: 'This harness has no supported local catalog. Commands stay literal.',
    }
  }

  let cwd: string

  try {
    cwd = await realpath(card.agent.cwd)

    if (!(await stat(cwd)).isDirectory()) {
      throw new Error('not a folder')
    }
  } catch {
    return {
      suggestions: [],
      unavailable: 'The session working folder is unavailable. Commands stay literal.',
    }
  }

  const reader = new Reader()
  reader.observe = observe
  const folders = await projectFolders({ cwd })
  const suggestions = new Map<string, Suggestion>()
  const skillFiles = new Set<string>()

  const add = ({
    command,
    meta,
    source,
    kind = 'skill',
    file,
    project,
    projectPath,
  }: {
    command: string
    meta: Record<string, unknown>
    source: string
    kind?: Suggestion['kind']
    file?: string
    project?: string
    projectPath?: string
  }) => {
    if (meta['user-invocable'] === false || suggestions.has(file ?? command)) {
      return
    }

    if (suggestions.size >= 200) {
      reader.partial = true

      return
    }

    suggestions.set(
      file ?? command,
      {
        command,
        kind,
        file,
        project,
        projectPath,
        source,
        description: typeof meta.description === 'string' ? meta.description.split(/\r?\n/)[0]!.slice(
          0,
          240,
        ) : 'Local harness command',
      },
    )
  }

  const skills = async (
    {
      root,
      source,
      prefix,
      project,
      projectPath,
      foreign = false,
    }: {
      root: string
      source: string
      prefix: string
      project?: string
      projectPath?: string
      foreign?: boolean
    },
  ) => {
    for (const entry of await reader.list({ path: root })) {
      if (entry.startsWith('.')) {
        continue
      }

      const path = join(
        root,
        entry,
        'SKILL.md',
      )
      let resolved: string

      try {
        resolved = await realpath(path)
      } catch {
        reader.observe?.({ path })
        continue
      }

      const identity = `${projectPath ?? ''}:${resolved}`

      if (skillFiles.has(identity)) {
        continue
      }

      skillFiles.add(identity)
      const meta = await reader.metadata({ path })

      if (!meta) {
        continue
      }

      const name = validName({ value: meta.name ?? entry })

      if (name) {
        add({
          command: prefix + name,
          meta,
          source,
          file: foreign ? path : undefined,
          project,
          projectPath,
        })
      }
    }
  }

  const commands = async (
    {
      root,
      source,
      prefix,
      recursive,
      depth = 0,
      seen = new Set<string>(),
    }: {
      root: string
      source: string
      prefix: string
      recursive: boolean
      depth?: number
      seen?: Set<string>
    },
  ) => {
    if (depth > 6) {
      reader.partial = true

      return
    }

    reader.observe?.({ path: root })
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

    for (const entry of await reader.list({ path: root })) {
      if (entry.startsWith('.')) {
        continue
      }

      const path = join(
        root,
        entry,
      )

      if (entry.endsWith('.md')) {
        const name = validName({
            value: basename(
              entry,
              '.md',
            ),
          }), meta = await reader.metadata({ path })

        if (name && meta) {
          add({
            command: prefix + name,
            meta,
            source,
            kind: 'command',
          })
        }
      } else if (recursive) {
        try {
          if ((await stat(path)).isDirectory()) {
            await commands({
              root: path,
              source,
              prefix,
              recursive: true,
              depth: depth + 1,
              seen,
            })
          }
        } catch { /* Gone during discovery. */ }
      }
    }
  }

  const prefix = provider === 'codex' ? '$' : '/'

  const activeProjects = projects.filter(project => !project.detached)
  const attached = await Promise.all(activeProjects.map(async project => {
    try {
      return {
        ...project,
        resolved: await realpath(project.path),
      }
    } catch {
      return {
        ...project,
        resolved: project.path,
      }
    }
  }))
  const ownProject = attached.find(project => folders.includes(project.resolved))
  const sessionSource = ownProject ? `Project · ${ownProject.name}` : 'Session skills'

  const localSkills = async ({
    family,
    foreign,
  }: {
    family: '.agents' | '.claude'
    foreign: boolean
  }) => {
    for (const folder of folders) {
      await skills({
        root: join(
          folder,
          family,
          'skills',
        ),
        source: sessionSource,
        prefix,
        foreign,
        project: ownProject?.name,
        projectPath: ownProject?.path,
      })
    }
  }

  if (provider === 'codex') {
    await localSkills({
      family: '.agents',
      foreign: false,
    })
    await skills({
      root: join(
        locations.codex,
        'skills',
      ),
      source: 'Agent skills',
      prefix,
    })
    await skills({
      root: join(
        locations.codex,
        'skills/.system',
      ),
      source: 'Agent skills',
      prefix,
    })
    await skills({
      root: join(
        locations.home,
        '.agents/skills',
      ),
      source: 'Global · .agents',
      prefix,
    })
    await skills({
      root: join(
        locations.claude,
        'skills',
      ),
      source: 'Global · .claude',
      prefix,
      foreign: true,
    })
    await localSkills({
      family: '.claude',
      foreign: true,
    })
  } else {
    await skills({
      root: join(
        locations.claude,
        'skills',
      ),
      source: 'Global · .claude',
      prefix,
    })
    await localSkills({
      family: '.claude',
      foreign: false,
    })
    await skills({
      root: join(
        locations.home,
        '.agents/skills',
      ),
      source: 'Global · .agents',
      prefix,
      foreign: true,
    })
    await localSkills({
      family: '.agents',
      foreign: true,
    })
  }

  for (const project of attached.filter(project => !folders.includes(project.resolved))) {
    for (const family of [
      '.agents',
      '.claude',
    ]) {
      await skills({
        root: join(
          project.path,
          family,
          'skills',
        ),
        source: `Project · ${project.name}`,
        prefix,
        foreign: true,
        project: project.name,
        projectPath: project.path,
      })
    }
  }

  if (provider === 'codex') {
    await commands({
      root: join(
        locations.codex,
        'prompts',
      ),
      source: 'Personal prompt',
      prefix: '/prompts:',
      recursive: false,
    })
  } else {
    const settings = [
      await reader.json({
        path: join(
          locations.claude,
          'settings.json',
        ),
      }),
    ]

    for (const folder of [...folders].reverse()) {
      for (const file of [
        'settings.json',
        'settings.local.json',
      ]) {
        settings.push(await reader.json({
          path: join(
            folder,
            '.claude',
            file,
          ),
        }))
      }
    }

    const enabled = Object.assign(
      {},
      ...settings.map(s => object({ value: s.enabledPlugins })),
    ) as Record<string, unknown>
    const overrides = Object.assign(
      {},
      ...settings.map(s => object({ value: s.skillOverrides })),
    ) as Record<string, unknown>

    for (const [
      key,
      item,
    ] of suggestions) {
      if (overrides[item.command.slice(1)] === 'off') {
        suggestions.delete(key)
      }
    }

    for (const folder of folders) {
      await commands({
        root: join(
          folder,
          '.claude/commands',
        ),
        source: 'Project command',
        prefix: '/',
        recursive: true,
      })
    }

    await commands({
      root: join(
        locations.claude,
        'commands',
      ),
      source: 'Personal command',
      prefix: '/',
      recursive: true,
    })
    const installed = await reader.json({
      path: join(
        locations.claude,
        'plugins/installed_plugins.json',
      ),
    })

    const plugins = Object.entries(object({
      value: installed.plugins,
    })).sort((
      [a],
      [b],
    ) =>
      sort({
        a,
        b,
      }))

    for (const [
      id,
      raw,
    ] of plugins) {
      if (enabled[id] !== true || !Array.isArray(raw)) {
        continue
      }

      // Most specific applicable installation wins; never enumerate plugin caches.
      const entries = raw.map(value => object({ value })).filter(e => typeof e.installPath === 'string' && isAbsolute(e.installPath) && (e.scope === 'user' || ((e.scope === 'project' || e.scope === 'local') && typeof e.projectPath === 'string' && folders.includes(resolve(e.projectPath)))))
        .sort((
          a,
          b,
        ) => String(b.scope).localeCompare(String(a.scope)))
      const installation = entries.find(e => e.scope === 'local') ?? entries.find(e => e.scope === 'project') ?? entries[0]

      if (!installation) {
        continue
      }

      const root = installation.installPath as string, manifest = await reader.json({
        path: join(
          root,
          '.claude-plugin/plugin.json',
        ),
      })
      const namespace = validName({ value: manifest.name ?? id.split('@')[0] })

      if (!namespace) {
        continue
      }

      const paths = ({ field }: { field: string }) => [
        field,
        ...(typeof manifest[field] === 'string' ? [manifest[field]] : Array.isArray(manifest[field]) ? manifest[field] : []),
      ].filter((p): p is string => typeof p === 'string').map(p => resolve(
        root,
        p,
      ))
        .filter(p => within({
          root,
          path: p,
        }))

      for (const path of [...new Set(paths({ field: 'skills' }))]) {
        await skills({
          root: path,
          source: `Plugin ${namespace}`,
          prefix: `/${namespace}:`,
        })
      }

      for (const path of [...new Set(paths({ field: 'commands' }))]) {
        if (path.endsWith('.md')) {
          const meta = await reader.metadata({ path }), name = validName({
            value: basename(
              path,
              '.md',
            ),
          })

          if (meta && name) {
            add({
              command: `/${namespace}:${name}`,
              meta,
              source: `Plugin ${namespace}`,
            })
          }
        } else {
          await commands({
            root: path,
            source: `Plugin ${namespace}`,
            prefix: `/${namespace}:`,
            recursive: true,
          })
        }
      }
    }
  }

  const sourceRank = ({ source }: { source: string }) => source.startsWith('Global') ? 0 : 1

  return {
    suggestions: [...suggestions.values()].sort((
      a,
      b,
    ) => sourceRank(a) - sourceRank(b) || sort({
      a: `${a.source}:${a.command}`,
      b: `${b.source}:${b.command}`,
    })),
    note: reader.partial ? 'Some local catalog files could not be read or exceeded the discovery limit.' : undefined,
  }
}
