import { useState } from 'react'
import { failedChecks, type Link } from '#tasks/delivery/model.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { Tooltip, LINK_TOOLTIP_DELAY } from '#web-shared/ui/tooltip.tsx'

const LINK_TONES: Record<string, string> = {
  open: 'bg-green',
  merged: 'bg-purple',
  failing: 'bg-coral',
  closed: 'bg-red',
}

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
  const tone = LINK_TONES[state ?? ''] ?? 'bg-muted'
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
        className="card-link inline-flex items-center gap-1.25 max-w-full min-w-0 py-0.5 px-1.75 border border-line rounded-full bg-background text-ink text-meta no-underline [&>span]:truncate [&_svg]:shrink-0"
        href={link.url}
        target="_blank"
        rel="noreferrer"
      >
        <Icon name={icon} size={ICON_SIZE.inline} />
        {state && <i className={`link-state size-1.5 shrink-0 rounded-full ${tone} link-${state}`} aria-label={state === 'failing' ? 'checks failed' : state} />}
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
    <div className={`card-links shrink-0 flex flex-wrap items-center gap-1.25 [&_h3]:basis-full [&_h3]:m-0 ${expanded ? 'expanded' : ''}`} aria-label="Task links">
      {expanded && <h3 className="eyebrow">Links</h3>}
      {shown.map(link => <LinkChip key={link.url} link={link} expanded={expanded} />)}
      {links.length > limit && (
        <Button className="quiet text-meta py-0.5 px-1.25" aria-expanded={all} onClick={() => setAll(value => !value)}>
          {all ? 'Show fewer' : `+${links.length - limit}${expanded ? ' more' : ''}`}
        </Button>
      )}
    </div>
  )
}
