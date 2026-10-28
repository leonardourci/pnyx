import type { Card } from '../../../src/tasks/model.ts'
import type { Link } from '../../../src/tasks/delivery/model.ts'

const HARNESSES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export const harnessName = ({ provider }: { provider: string }) => HARNESSES[provider] ?? provider

export function safeLink({ link }: { link: Link }): string | undefined {
  try {
    const url = new URL(link.url)

    return [
      'https:',
      'http:',
    ].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

// A worker whose session ended is stopped, so a dead job never reads as active.
export function agentActivity({ card }: { card: Card }): 'working' | 'finished' | 'stopped' | undefined {
  if (!card.agent) {
    return undefined
  }

  const activity = card.sessionActivity ?? card.activity

  return activity === 'ended' || card.outcome?.state === 'ended' ? 'stopped' : activity === 'working' ? 'working' : activity === 'finished' ? 'finished' : undefined
}

export const slashPrefix = ({
  text,
  cursor,
}: {
  text: string
  cursor: number
}) => /(?:^|\s)(\/[a-z0-9_.:-]*)$/i.exec(text.slice(
  0,
  cursor,
))?.[1] ?? null
export const slashMatches = ({
  command,
  prefix,
}: {
  command: string
  prefix: string
}) => command.replace(
  /^[$/]/,
  '',
).toLowerCase()
  .startsWith(prefix.replace(
    /^\//,
    '',
  ).toLowerCase())

export const needsAgent = ({ card }: { card: Card }) => !card.agent && !card.sourceRefs.some(r => r.adapter === 'firstmate')
