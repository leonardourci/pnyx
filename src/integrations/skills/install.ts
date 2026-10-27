import {
  ORCHESTRATE_SKILL,
  REPORT_PROGRESS_SKILL,
  CLI_SKILL,
  HYDRA_SKILLS,
  GLOBAL_SKILLS,
} from './names.ts'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { HydraError } from '../../core/model.ts'

const LEGACY_SKILLS = [
  'pnyx-hydra',
  'pnyx-hydra-workers',
  'pnyx-hydra-columns',
  'pnyx-hydra-firstmate',
  'pnyx-setup',
  'pnyx-worker',
  'inscribe',
  'pnyx',
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

export function removeLegacyHydraSkills({
  folder,
  owns = () => true,
}: {
  folder: string
  owns?: ({ path }: { path: string }) => boolean
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
      )).isFile() && owns({ path })) {
      rmSync(
        path,
        { recursive: true },
      )
    }
  }
}

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
export function prepareHydraFolder({
  folder,
  instructions,
}: {
  folder: string
  instructions?: string
}) {
  const contract = readFileSync(
    skillSource({ name: ORCHESTRATE_SKILL }),
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
    instructions ? `${instructions}\n\n${contract}` : contract,
  )
  writeFileSync(
    join(
      folder,
      'CLAUDE.md',
    ),
    '@AGENTS.md\n',
  )
  removeLegacyHydraSkills({ folder })
  copySkills({
    folder,
    names: HYDRA_SKILLS,
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
  const conflict = !remove && links.find(link => link.status === 'conflict')

  if (conflict) {
    throw new HydraError({
      message: `cannot replace existing skill at ${conflict.path}`,
      code: 'SKILL_CONFLICT',
      help: ['Move the existing skill aside, then rerun `pnyx-axi setup skills`'],
    })
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
    skills: [
      ...skills,
      ...legacy,
    ],
    ...(preview ? { preview: 'nothing written; rerun without --preview to apply' } : {}),
    help: [remove ? 'Run `pnyx-axi setup skills` to install them again' : `New sessions can load ${REPORT_PROGRESS_SKILL} and ${CLI_SKILL} in any project or copy`],
  }
}
