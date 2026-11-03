import type { Card } from '#tasks/model.ts'
import { PROVIDERS } from '#workers/providers.ts'

export const harnessName = ({ provider }: { provider: string }) =>
  Object.values(PROVIDERS).find(entry => entry.provider === provider)?.name ?? provider

export const needsAgent = ({ card }: { card: Card }) => !card.agent && !card.sourceRefs.some(r => r.adapter === 'firstmate')
