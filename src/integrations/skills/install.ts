import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { HydraError } from '../../core/model.ts'

// pnyx-hydra is Hydra's contract; the others are the details it loads on demand.
export const HYDRA_SKILLS = [
  'pnyx-hydra',
  'pnyx-hydra-workers',
  'pnyx-hydra-columns',
  'pnyx-hydra-firstmate',
  'inscribe',
  'pnyx-setup',
] as const
const SKILLS = [
  ...HYDRA_SKILLS,
  'pnyx-worker',
] as const
const SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'skills',
)

export const skillSource = ({ name }: { name: string }) => join(
  SOURCE,
  name,
  'SKILL.md',
)

export function copySkills({
  folder,
  names,
}: {
  folder: string
  names: readonly string[]
}): string[] {
  return names.map(name => {
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
      readFileSync(skillSource({ name })),
    )

    return dir
  })
}

// The hosted Hydra's folder: its contract, which both harnesses load every turn, and the skills it loads on demand.
export function prepareHydraFolder({ folder }: { folder: string }) {
  const contract = readFileSync(
    skillSource({ name: 'pnyx-hydra' }),
    'utf8',
  ).replace(
    /^---\n[\s\S]*?\n---\n+/,
    '',
  )
  mkdirSync(
    folder,
    { recursive: true },
  )
  writeFileSync(
    join(
      folder,
      'AGENTS.md',
    ),
    contract,
  )
  writeFileSync(
    join(
      folder,
      'CLAUDE.md',
    ),
    '@AGENTS.md\n',
  )
  // Earlier versions copied the whole contract here as a skill.
  rmSync(
    join(
      folder,
      '.agents',
      'skills',
      'pnyx-hydra',
    ),
    {
      recursive: true,
      force: true,
    },
  )
  copySkills({
    folder,
    names: HYDRA_SKILLS.filter(name => name !== 'pnyx-hydra'),
  })
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

  return folders.flatMap(folder => SKILLS.flatMap(name => {
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
  const conflict = !remove && links.find(link => link.status === 'conflict')

  if (conflict) {
    throw new HydraError({
      message: `cannot replace existing skill at ${conflict.path}`,
      code: 'SKILL_CONFLICT',
      help: ['Move the existing skill aside, then rerun `pnyx-axi setup skills`'],
    })
  }

  const skills = links.map(link => {
    const change = remove ? (link.owned ? 'removed' : 'unchanged') : link.status === 'ready' ? 'unchanged' : 'installed'

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
    skills,
    ...(preview ? { preview: 'nothing written; rerun without --preview to apply' } : {}),
    help: [remove ? 'Run `pnyx-axi setup skills` to install them again' : 'New sessions can load the Hydra skills and pnyx-worker in any project or copy'],
  }
}
