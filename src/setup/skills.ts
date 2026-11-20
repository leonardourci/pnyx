import { inform } from '#app/command-notices.ts'
import { log } from '#app/diagnostics.ts'
import {
  ORCHESTRATE_SKILL,
  REPORT_PROGRESS_SKILL,
  CLI_SKILL,
  HYDRA_SKILLS,
  GLOBAL_SKILLS,
} from './skill-names.ts'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const LEGACY_SKILLS = [
  'pnyx-hydra',
  'pnyx-hydra-workers',
  'pnyx-hydra-columns',
  'pnyx-hydra-firstmate',
  'pnyx-firstmate-as-hydra',
  'pnyx-setup',
  'pnyx-worker',
  'pnyx-inscribe',
  'pnyx',
] as const
const SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  'skills',
)

export const skillSource = ({ name }: { name: string }) => join(
  SOURCE,
  name,
  'SKILL.md',
)

export function removeLegacyHydraSkills({
  folder,
}: {
  folder: string
}) {
  for (const name of LEGACY_SKILLS.filter(name => name !== 'pnyx-worker' && name !== 'pnyx')) {
    const path = join(
      folder,
      '.agents',
      'skills',
      name,
    )

    if (!lstatSync(
      path,
      { throwIfNoEntry: false },
    )?.isDirectory()) {
      continue
    }

    const files = readdirSync(path)

    if (files.length === 1 && files[0] === 'SKILL.md'
      && lstatSync(join(
        path,
        'SKILL.md',
      )).isFile()) {
      rmSync(
        path,
        { recursive: true },
      )
    }
  }
}

function syncReferences({
  shippedFolder,
  installedFolder,
}: {
  shippedFolder: string
  installedFolder: string
}) {
  const shipped = existsSync(shippedFolder) ? readdirSync(shippedFolder) : []

  if (!shipped.length) {
    rmSync(
      installedFolder,
      {
        recursive: true,
        force: true,
      },
    )

    return
  }

  cpSync(
    shippedFolder,
    installedFolder,
    { recursive: true },
  )
  const dropped = readdirSync(installedFolder).filter(file => !shipped.includes(file))

  for (const file of dropped) {
    rmSync(
      join(
        installedFolder,
        file,
      ),
      {
        recursive: true,
        force: true,
      },
    )
  }
}

export function copySkills({
  folder,
  names,
  missing,
}: {
  folder: string
  names: readonly string[]
  missing?: ({ path }: { path: string }) => void
}): string[] {
  const installed: string[] = []

  for (const name of names) {
    const source = skillSource({ name })
    let content: string

    try {
      content = readFileSync(
        source,
        'utf8',
      )
    } catch (error) {
      if (missing && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        missing({ path: source })

        continue
      }

      throw error
    }

    const dir = join(
      folder,
      '.agents',
      'skills',
      name,
    )
    mkdirSync(
      dir,
      { recursive: true },
    )
    writeFileSync(
      join(
        dir,
        'SKILL.md',
      ),
      content,
    )
    syncReferences({
      shippedFolder: join(
        dirname(source),
        'references',
      ),
      installedFolder: join(
        dir,
        'references',
      ),
    })
    installed.push(dir)
  }

  return installed
}

export function prepareHelperFolder({
  folder,
  instructions,
}: {
  folder: string
  instructions: string
}) {
  mkdirSync(
    folder,
    { recursive: true },
  )

  removeLegacyHydraSkills({ folder })

  for (const name of HYDRA_SKILLS) {
    rmSync(
      join(
        folder,
        '.agents',
        'skills',
        name,
      ),
      {
        recursive: true,
        force: true,
      },
    )
  }

  writeFileSync(
    join(
      folder,
      'AGENTS.md',
    ),
    instructions + '\n',
  )
  writeFileSync(
    join(
      folder,
      'CLAUDE.md',
    ),
    '@AGENTS.md\n',
  )
}

// The hosted Hydra's folder: its contract, which both harnesses load every turn, and the skills it loads on demand.
export function prepareHydraFolder({
  folder,
  instructions,
}: {
  folder: string
  instructions?: string
}) {
  mkdirSync(
    folder,
    { recursive: true },
  )
  removeLegacyHydraSkills({ folder })
  const installed = copySkills({
    folder,
    names: HYDRA_SKILLS,
    missing: ({ path }) => log({
      level: 'warn',
      operation: 'skills.missing',
      // The skill's folder names it; the rest of the path is the install's.
      name: basename(dirname(path)),
      error: 'A shipped skill is missing; Hydra continues with the others. Run /upgrade to repair the install.',
    }),
  })
  const orchestrate = join(
    folder,
    '.agents',
    'skills',
    ORCHESTRATE_SKILL,
  )
  let contract = 'The shipped Pnyx orchestration skill is missing. Tell the owner to run /upgrade to repair the install before taking on work.'

  if (installed.includes(orchestrate)) {
    contract = readFileSync(
      join(
        orchestrate,
        'SKILL.md',
      ),
      'utf8',
    ).replace(
      /^---\n[\s\S]*?\n---\n+/,
      '',
    )
      .replaceAll(
        '(references/',
        `(.agents/skills/${ORCHESTRATE_SKILL}/references/`,
      )
  }

  writeFileSync(
    join(
      folder,
      'AGENTS.md',
    ),
    instructions ? `${instructions}\n\n${contract}` : contract,
  )
  writeFileSync(
    join(
      folder,
      'CLAUDE.md',
    ),
    '@AGENTS.md\n',
  )
  const claude = join(
    folder,
    '.claude',
    'skills',
  )

  if (!lstatSync(
    claude,
    { throwIfNoEntry: false },
  )) {
    mkdirSync(
      dirname(claude),
      { recursive: true },
    )
    symlinkSync(
      join(
        '..',
        '.agents',
        'skills',
      ),
      claude,
      'dir',
    )
  }
}

export interface SkillLocation {
  userHome?: string
  claudeConfigDir?: string
}

interface SetupOptions extends SkillLocation {
  remove?: boolean
  preview?: boolean
}

function canonicalPath({ path }: { path: string }): string {
  if (existsSync(path)) {
    return realpathSync(path)
  }

  return join(
    canonicalPath({ path: dirname(path) }),
    basename(path),
  )
}

export function skillLinks(
  {
    userHome = homedir(),
    claudeConfigDir = process.env.CLAUDE_CONFIG_DIR,
  }: SkillLocation = {},
) {
  const folders = [
    join(
      claudeConfigDir || join(
        userHome,
        '.claude',
      ),
      'skills',
    ),
    join(
      userHome,
      '.agents',
      'skills',
    ),
  ]
  const paths = new Set<string>()

  return folders.flatMap(folder => GLOBAL_SKILLS.flatMap(name => {
    const path = join(
      canonicalPath({ path: resolve(folder) }),
      name,
    )

    if (paths.has(path)) {
      return []
    }

    paths.add(path)
    const source = resolve(
      SOURCE,
      name,
    )
    const stat = lstatSync(
      path,
      { throwIfNoEntry: false },
    )
    const owned = stat?.isSymbolicLink() && resolve(
      dirname(path),
      readlinkSync(path),
    ) === source
    const status = !stat ? 'missing' : owned && existsSync(join(
      source,
      'SKILL.md',
    )) ? 'ready' : 'conflict'

    return [
      {
        name,
        path,
        source,
        status,
        owned: !!owned,
      },
    ]
  }))
}

export function skillStatus({
  userHome,
  claudeConfigDir,
}: SkillLocation = {}): string {
  const links = skillLinks({
    userHome,
    claudeConfigDir,
  })
  const pending = links.filter(link => link.status !== 'ready')
  const conflict = pending.find(link => link.status === 'conflict')

  return conflict ? `conflict: ${conflict.path}` : pending.length ? `missing: ${pending.length} global skill links` : 'ready'
}

export function setupSkills(
  {
    remove = false,
    preview = false,
    userHome,
    claudeConfigDir,
  }: SetupOptions = {},
) {
  const links = skillLinks({
    userHome,
    claudeConfigDir,
  })
  if (!remove) {
    for (const link of links.filter(link => link.status === 'conflict')) {
      inform({
        reason: `Kept the existing skill at ${link.path}`,
        clear: 'Move that skill aside and run pnyx-axi setup skills to install the Pnyx link',
      })
    }
  }

  const folders = [...new Set(links.map(link => dirname(link.path)))]
  const legacy = folders.flatMap(folder => LEGACY_SKILLS.flatMap(name => {
    const path = join(
      folder,
      name,
    )

    if (!lstatSync(
      path,
      { throwIfNoEntry: false },
    )?.isSymbolicLink()) {
      return []
    }

    const source = resolve(
      folder,
      readlinkSync(path),
    )

    if (basename(source) !== name || basename(dirname(source)) !== 'skills') {
      return []
    }

    try {
      const pkg = JSON.parse(readFileSync(
        join(
          dirname(source),
          '..',
          'package.json',
        ),
        'utf8',
      ))

      if (pkg.name !== 'pnyx-axi') {
        return []
      }
    } catch {
      return []
    }

    return [
      {
        name,
        path,
        source,
        change: 'removed',
      },
    ]
  }))

  if (!preview) {
    for (const link of legacy) {
      unlinkSync(link.path)
    }
  }

  const skills = links.map(link => {
    const keep = link.status === 'ready' || link.status === 'conflict'
    const change = remove ? (link.owned ? 'removed' : 'unchanged') : keep ? 'unchanged' : 'installed'

    if (!preview && change === 'installed') {
      mkdirSync(
        dirname(link.path),
        { recursive: true },
      )
      symlinkSync(
        link.source,
        link.path,
        'dir',
      )
    } else if (!preview && change === 'removed') {
      unlinkSync(link.path)
    }

    return {
      name: link.name,
      path: link.path,
      source: link.source,
      change,
    }
  })

  return {
    skills: [
      ...skills,
      ...legacy,
    ],
    ...(preview ? { preview: 'nothing written; rerun without --preview to apply' } : {}),
    help: [remove ? 'Run `pnyx-axi setup skills` to install them again' : `New sessions can load ${REPORT_PROGRESS_SKILL} and ${CLI_SKILL} in any project or copy`],
  }
}
