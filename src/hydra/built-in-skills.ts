import { INSCRIBE_SKILL, SET_UP_SKILL } from '#setup/skill-names.ts'
import { HYDRA_CARD } from './identity.ts'
import type { Catalog, Suggestion } from './transcripts-catalog.ts'

export const BUILT_IN_SKILLS = [
  {
    name: INSCRIBE_SKILL,
    description: 'Curate and save owner, Hydra or project memory.',
  },
  {
    name: SET_UP_SKILL,
    description: 'Check and complete Pnyx setup for this Hydra.',
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
  if (card !== HYDRA_CARD) {
    return catalog
  }

  const prefix = provider === 'codex' ? '$' : '/'
  const builtins: Suggestion[] = BUILT_IN_SKILLS.map(skill => ({
    command: `${prefix}${skill.name}`,
    description: skill.description,
    source: 'Built-in',
    kind: 'skill',
    builtin: true,
  }))

  return {
    ...catalog,
    suggestions: [
      ...builtins,
      ...catalog.suggestions.filter(item => !item.builtin),
    ],
  }
}
