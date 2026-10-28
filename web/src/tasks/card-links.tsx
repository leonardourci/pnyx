import { useState } from 'react'
import { failedChecks, type Link } from '../../../src/tasks/delivery/model.ts'
import { Button } from '../shared/ui/controls.tsx'
import { Icon } from '../shared/ui/icon.tsx'
import { Tooltip, LINK_TOOLTIP_DELAY } from '../shared/ui/tooltip.tsx'

const CLOSED_LINKS = 2
const OPEN_LINKS = 3
export const LINK_ICONS: Record<string, string> = {
  github_pr: 'github',
  linear: 'linear',
  url: 'paperclip',
}

// An open pull request with a failed check shows coral, so it reads apart from a green one.
const linkState = ({ link }: { link: Link }) =>
  link.state === 'open' && failedChecks({ checks: link.checks }) > 0 ? 'failing' : link.state

// A link without a number or title shows the end of its path; the tooltip keeps the full URL.
const shortUrl = ({ url }: { url: string }) => {
  try {
    const parsed = new URL(url)

    return parsed.pathname.split('/').filter(Boolean)
      .at(-1) ?? parsed.host
  } catch {
    return url
  }
}

export function LinkChip({
  link,
  expanded,
}: {
  link: Link
  expanded: boolean
}) {
  const number = link.kind === 'linear'
    ? /\/issue\/([a-z]+-\d+)/i.exec(link.url)?.[1] || ''
    : link.number && `#${link.number}` || ''
  const title = link.title || number || shortUrl({ url: link.url })
  const label = expanded && number && link.title ? `${number} · ${title}` : number || title
  const state = linkState({ link })
  const checks = link.checks && <span>Checks: {link.checks}</span>
  let pending: string | undefined

  if (link.state !== 'merged' && link.mergeAttempt) {
    pending = link.mergeAttempt.outcome === 'queued' ? 'merge queued' : 'merge unconfirmed'
  }

  const tooltip = (
    <><strong>{title}</strong><span>{link.url}</span>{checks}
      {pending && <span>{link.mergeAttempt?.detail || pending}</span>}
    </>
  )
  const icon = LINK_ICONS[link.kind]

  return (
    <Tooltip delay={LINK_TOOLTIP_DELAY} content={tooltip}>
      <a
        className="card-link"
        href={link.url}
        target="_blank"
        rel="noreferrer"
      >
        <Icon name={icon} size={13} />
        {state && <i className={`link-state link-${state}`} aria-label={state === 'failing' ? 'checks failed' : state} />}
        <span>{label}{pending && ` · ${pending}`}</span>
      </a>
    </Tooltip>
  )
}

export function CardLinks({
  links,
  expanded,
}: {
  links: Link[]
  expanded: boolean
}) {
  const [
    all,
    setAll,
  ] = useState(false)
  const limit = expanded ? OPEN_LINKS : CLOSED_LINKS
  const shown = all ? links : links.slice(
    0,
    limit,
  )

  if (!links.length) {
    return null
  }

  return (
    <div className={`card-links ${expanded ? 'expanded' : ''}`} aria-label="Task links">
      {expanded && <h3 className="eyebrow">Links</h3>}
      {shown.map(link => <LinkChip key={link.url} link={link} expanded={expanded} />)}
      {links.length > limit && (
        <Button className="quiet" aria-expanded={all} onClick={() => setAll(value => !value)}>
          {all ? 'Show fewer' : `+${links.length - limit}${expanded ? ' more' : ''}`}
        </Button>
      )}
    </div>
  )
}
