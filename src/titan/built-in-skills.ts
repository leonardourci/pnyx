import { INSCRIBE_SKILL, SET_UP_SKILL } from '#setup/skill-names.ts'
import { skillPrefix } from '#workers/providers.ts'
import { isServerCommand, UPGRADE_SUGGESTION, RESTART_SUGGESTION } from '#upgrade/model.ts'
import { TITAN_CARD } from './identity.ts'
import type { Catalog, Suggestion } from './transcripts-catalog.ts'

// Add project, typed inline: the composer turns it into its request with a project and folder picker.
export const ADD_PROJECT_COMMAND = '/add-project'
const ADD_PROJECT_SUGGESTION: Suggestion = {
  command: ADD_PROJECT_COMMAND,
  description: 'Ask Titan to add a project or folder to this Titan.',
  source: 'Built-in',
  kind: 'command',
}

export const BUILT_IN_SKILLS = [
  {
    name: INSCRIBE_SKILL,
    description: 'Curate and save owner, Titan or project memory.',
  },
  {
    name: SET_UP_SKILL,
    description: 'Check and complete Othrys setup for this Titan.',
  },
] as const

export function withBuiltInSkills({
  catalog,
  card,
  provider,
}: {
  catalog: Catalog
  card: string
  provider?: string
}): Catalog {
  if (card !== TITAN_CARD) {
    return catalog
  }

  const prefix = skillPrefix({ provider })
  const builtins: Suggestion[] = BUILT_IN_SKILLS.map(skill => ({
    command: `${prefix}${skill.name}`,
    description: skill.description,
    source: 'Built-in',
    kind: 'skill',
    builtin: true,
  }))

  const external = catalog.suggestions.filter(item =>
    !item.builtin && !isServerCommand({ item }) && item.command !== ADD_PROJECT_COMMAND)

  return {
    ...catalog,
    suggestions: [
      ...builtins,
      UPGRADE_SUGGESTION,
      RESTART_SUGGESTION,
      ADD_PROJECT_SUGGESTION,
      ...external,
    ],
  }
}
