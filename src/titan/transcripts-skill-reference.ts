import { reference } from './mentions.ts'
import type { Suggestion } from './transcripts-catalog.ts'

export interface SkillReference {
  name: string
  command?: string
  file?: string
  project?: string
  projectPath?: string
  builtin?: boolean
}

export function readSkillReference({ value }: { value: string }): SkillReference | undefined {
  try {
    const skill: unknown = JSON.parse(value)

    if (!skill || typeof skill !== 'object' || !('name' in skill) || typeof skill.name !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(skill.name)) {
      return
    }

    for (const [
      key,
      value,
    ] of Object.entries(skill)) {
      if ([
        'file',
        'project',
        'projectPath',
        'command',
      ].includes(key)
        && (typeof value !== 'string' || /[\r\n\0]/.test(value))) {
        return
      }
    }

    const text = ({ key }: { key: string }) => {
      const value: unknown = Reflect.get(
        skill,
        key,
      )

      return typeof value === 'string' ? value : undefined
    }

    const builtin = 'builtin' in skill ? skill.builtin : undefined

    if (builtin !== undefined && builtin !== true) {
      return
    }

    const file = text({ key: 'file' })

    if (file && (!file.startsWith('/') || !file.endsWith('/SKILL.md'))) {
      return
    }

    return {
      name: skill.name,
      builtin,
      file,
      project: text({ key: 'project' }),
      projectPath: text({ key: 'projectPath' }),
      command: text({ key: 'command' }),
    }
  } catch {
    return
  }
}

export function skillReference({ item }: { item: Suggestion }): string {
  const name = item.command.replace(
    /^[$/]/,
    '',
  )

  return reference({
    kind: 'skill',
    label: `${item.project ? `${item.project} ` : ''}/${name}`,
    value: JSON.stringify({
      name,
      builtin: item.builtin,
      command: item.kind === 'command' ? item.command : undefined,
      file: item.file,
      project: item.project,
      projectPath: item.projectPath,
    }),
  })
}
