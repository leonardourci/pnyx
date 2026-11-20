import { inform } from '#app/command-notices.ts'
import type { Learning } from './learnings.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'

export const OWNER_MEMORY_BUDGET = 24000

// Hydra memory holds only what this Hydra needs: its scope, where it left off, its check cursor.
export const HYDRA_MEMORY_BUDGET = 1500

export const OWNER_DOCUMENTS = {
  preferences: 'Owner preferences',
  learnings: 'Learnings',
} as const

// The share of a budget past which the digest asks Hydra to curate that memory.
const NEARLY_FULL = 0.8

export type Memory = Record<string, {
  text: string
  at: string
  lines?: Learning[]
}>

export const memorySize = ({ memory }: { memory: Memory }) =>
  Object.values(memory).reduce(
    (
      size,
      entry,
    ) => size + entry.text.length,
    0,
  )

export function checkBudget({
  memory,
  key,
  after,
  budget,
  layer,
}: {
  memory: Memory
  key: string
  after: string | null
  budget: number
  layer: string
}): void {
  const used = memorySize({ memory })
  const size = used - (Object.hasOwn(
    memory,
    key,
  ) ? memory[key]!.text.length : 0) + (after?.length ?? 0)

  if (after !== null && size > budget && size > used) {
    inform({
      reason: `${layer} memory uses ${size} of ${budget} characters`,
      clear: `Use pnyx-axi ${layer.toLowerCase()} memory list and ${layer.toLowerCase()} memory forget, or the ${INSCRIBE_SKILL} skill, to curate it`,
    })
  }
}

export const usage = ({
  layer,
  memory,
  budget,
}: {
  layer: string
  memory: Memory
  budget: number
}) => {
  const used = memorySize({ memory })

  return `${layer} memory uses ${used} of ${budget} characters.${used > budget * NEARLY_FULL ? ` Load the ${INSCRIBE_SKILL} skill and curate it before it fills.` : ''}`
}
