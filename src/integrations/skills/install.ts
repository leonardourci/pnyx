import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { HydraError } from '../../core/model.ts'

const SKILLS = ['pnyx-hydra', 'pnyx-worker'] as const
const SOURCE = join(import.meta.dirname, '..', '..', '..', 'skills')

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

  return join(canonicalPath({ path: dirname(path) }), basename(path))
}

export function skillLinks(
  { userHome = homedir(), claudeConfigDir = process.env.CLAUDE_CONFIG_DIR }: SkillLocation = {},
) {
  const folders = [join(claudeConfigDir || join(userHome, '.claude'), 'skills'), join(userHome, '.agents', 'skills')]
  const paths = new Set<string>()

  return folders.flatMap(folder => SKILLS.flatMap(name => {
    const path = join(canonicalPath({ path: resolve(folder) }), name)

    if (paths.has(path)) {
      return []
    }

    paths.add(path)
    const source = resolve(SOURCE, name)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    const owned = stat?.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === source
    const status = !stat ? 'missing' : owned && existsSync(join(source, 'SKILL.md')) ? 'ready' : 'conflict'

    return [{ name, path, source, status, owned: !!owned }]
  }))
}

export function skillStatus({ userHome, claudeConfigDir }: SkillLocation = {}): string {
  const links = skillLinks({ userHome, claudeConfigDir })
  const pending = links.filter(link => link.status !== 'ready')
  const conflict = pending.find(link => link.status === 'conflict')

  return conflict ? `conflict: ${conflict.path}` : pending.length ? `missing: ${pending.length} global skill links` : 'ready'
}

export function setupSkills(
  { remove = false, preview = false, userHome, claudeConfigDir }: SetupOptions = {},
) {
  const links = skillLinks({ userHome, claudeConfigDir })
  const conflict = !remove && links.find(link => link.status === 'conflict')

  if (conflict) {
    throw new HydraError({ message: `cannot replace existing skill at ${conflict.path}`, code: 'SKILL_CONFLICT', help: ['Move the existing skill aside, then rerun `pnyx-axi setup skills`'] })
  }

  const skills = links.map(link => {
    const change = remove ? (link.owned ? 'removed' : 'unchanged') : link.status === 'ready' ? 'unchanged' : 'installed'

    if (!preview && change === 'installed') {
      mkdirSync(dirname(link.path), { recursive: true })
      symlinkSync(link.source, link.path, 'dir')
    } else if (!preview && change === 'removed') {
      unlinkSync(link.path)
    }

    return { name: link.name, path: link.path, source: link.source, change }
  })

  return {
    skills,
    ...(preview ? { preview: 'nothing written; rerun without --preview to apply' } : {}),
    help: [remove ? 'Run `pnyx-axi setup skills` to install them again' : 'New sessions can load pnyx-hydra and pnyx-worker in any project or copy'],
  }
}
