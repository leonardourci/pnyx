import { LINK_KINDS, LINK_STATES, type Link } from './model.ts'
import { invalid } from '#app/command-validation.ts'
import type { HydraState, Decision } from '#app/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { isStaleLink } from './events.ts'
import { decided } from '#app/decision.ts'

export function parseLink({ input }: {
  input: {
    url: string
    kind?: string
    number?: string
    title?: string
    state?: string
    checkedAt?: string
  }
}): Link {
  let url: URL

  try {
    url = new URL(input.url)
  } catch {
    throw invalid({ message: `not a URL: ${input.url}` })
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid({ message: 'link URL must be http or https' })
  }

  const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname)
  const isGitHubPr = url.hostname === 'github.com' && pr !== null
  const kind = input.kind ?? (isGitHubPr ? 'github_pr' : 'url')

  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    throw invalid({ message: `kind must be one of ${LINK_KINDS.join(', ')}` })
  }

  if (input.state !== undefined && !(LINK_STATES as readonly string[]).includes(input.state)) {
    throw invalid({ message: `state must be one of ${LINK_STATES.join(', ')}` })
  }

  const number = input.number ?? (isGitHubPr ? pr[1] : undefined)

  if (number !== undefined && !/^\d+$/.test(number)) {
    throw invalid({ message: 'number must be a positive integer' })
  }

  const link: Link = {
    kind: kind as Link['kind'],
    url: input.url,
  }

  if (number !== undefined) {
    link.number = Number(number)
  }

  if (input.title) {
    link.title = input.title
  }

  if (input.state) {
    link.state = input.state as Link['state']
  }

  if (input.checkedAt) {
    link.checkedAt = input.checkedAt
  }

  return link
}

export function decideLink(
  {
    state,
    ref,
    url,
    link,
    meta,
  }: {
    state: HydraState
    ref: string
    url: string
    link: Link | null
    meta: Meta
  },
): Decision {
  const card = findCard({
    state,
    ref,
  })
  const current = card.links.find(l => l.url === url)

  if (!link && !current) {
    return { skipped: 'unchanged' }
  }

  const after = link ? {
    ...current,
    ...link,
  } : null

  if (after && isStaleLink({
    current,
    next: after,
  })) {
    return { skipped: 'stale' }
  }

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.linked',
      data: {
        url,
        before: current ?? null,
        after,
      },
    },
  })
}
