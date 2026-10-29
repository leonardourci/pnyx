import type { Card } from '#tasks/model.ts'

const HARNESSES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export const harnessName = ({ provider }: { provider: string }) => HARNESSES[provider] ?? provider

export const needsAgent = ({ card }: { card: Card }) => !card.agent && !card.sourceRefs.some(r => r.adapter === 'firstmate')
