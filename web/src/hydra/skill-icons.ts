import { ADD_PROJECT_COMMAND } from '#hydra/built-in-skills.ts'
import type { Suggestion } from '#hydra/transcripts-catalog.ts'
import type { SkillReference } from '#hydra/transcripts-skill-reference.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { isServerCommand, RESTART_COMMAND, UPGRADE_COMMAND } from '#upgrade/model.ts'

const BUILTIN_ICONS: Record<string, string> = {
  [INSCRIBE_SKILL]: 'inscribe',
}
const COMPACT_NAME = /compact/i

export function skillIcon({ skill }: { skill: SkillReference }): string {
  if (skill.command === UPGRADE_COMMAND) {
    return 'upgrade'
  }

  if (skill.command === RESTART_COMMAND) {
    return 'restart'
  }

  if (skill.builtin && Object.hasOwn(
    BUILTIN_ICONS,
    skill.name,
  )) {
    return BUILTIN_ICONS[skill.name]
  }

  return 'star'
}

export function slashIcons({ item }: { item: Suggestion }): string[] | undefined {
  if (item.builtin || isServerCommand({ item })) {
    return [
      skillIcon({
        skill: {
          ...item,
          name: item.command.slice(1),
        },
      }),
    ]
  }

  if (COMPACT_NAME.test(item.command)) {
    return ['compact']
  }

  return item.command === ADD_PROJECT_COMMAND ? ['attach'] : undefined
}
