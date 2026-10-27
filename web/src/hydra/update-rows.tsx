import type { MouseEvent, ReactNode } from 'react'
import { Button } from '../components/ui/controls.tsx'
import { CollapsibleText, Disclosure } from '../components/ui/disclosure.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Tooltip } from '../components/ui/tooltip.tsx'
import { LINK_ICONS, LinkChip } from './card-links.tsx'
import type { TaskUpdate, UpdateKind } from '../../../src/core/updates.ts'
import type { UpdateGroup } from './task-updates.ts'

const KINDS: Record<UpdateKind, {
  icon: string
  label: string
}> = {
  ask: {
    icon: 'you',
    label: 'You asked',
  },
  hydra: {
    icon: 'hydra',
    label: 'Hydra, from its chat reply',
  },
  told: {
    icon: 'send',
    label: 'Hydra told the worker',
  },
  decision: {
    icon: 'decision',
    label: 'Decision',
  },
  status: {
    icon: 'agent',
    label: 'Worker update',
  },
  worker: {
    icon: 'agent',
    label: 'Worker',
  },
  link: {
    icon: 'link',
    label: 'Link',
  },
  created: {
    icon: 'plus',
    label: 'Created',
  },
  moved: {
    icon: 'moved',
    label: 'Moved',
  },
  renamed: {
    icon: 'renamed',
    label: 'Renamed',
  },
  done: {
    icon: 'done',
    label: 'Done',
  },
  report: {
    icon: 'send',
    label: 'Reported to Hydra',
  },
  plain: {
    icon: 'summary',
    label: 'Update',
  },
}

const stateLabel = ({ state }: { state: string }) =>
  state === 'needs_you' ? 'Needs you' : state.replace(
    /^./,
    c => c.toUpperCase(),
  )

const shortTime = ({ at }: { at: string }) => new Date(at).toLocaleString(
  [],
  {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
)

function UpdateIcon({
  kind,
  icon = KINDS[kind].icon,
  label = KINDS[kind].label,
}: {
  kind: UpdateKind
  icon?: string
  label?: string
}) {
  return (
    <Tooltip content={label}>
      <span className={`update-icon update-icon-${kind}`} role="img" aria-label={label}><Icon name={icon} size={14} /></span>
    </Tooltip>
  )
}

// A folded row's summary holds the time as plain text: a summary takes no focusable content.
function UpdateTime({
  at,
  plain,
}: {
  at: string
  plain?: boolean
}) {
  const time = <time dateTime={at} tabIndex={plain ? undefined : 0}>{shortTime({ at })}</time>

  return plain ? time : <Tooltip content={new Date(at).toLocaleString()}>{time}</Tooltip>
}

function UpdateLine({
  kind,
  icon,
  label,
  at,
  plain,
  title,
  children,
}: {
  kind: UpdateKind
  icon?: string
  label?: string
  at?: string
  plain?: boolean
  title?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="update-line">
      <UpdateIcon kind={kind} icon={icon} label={label} />
      <div className="update-main">
        {at && <UpdateTime at={at} plain={plain} />}
        {title && <div className="update-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}

const linkIcon = ({ update }: { update: TaskUpdate }) => LINK_ICONS[update.link?.kind ?? ''] ?? 'paperclip'

function UpdateTitle({ update }: { update: TaskUpdate }) {
  return update.kind === 'link' && update.link
    ? <>{update.state} <LinkChip link={update.link} expanded={false} /></>
    : <>{stateLabel({ state: update.state })}</>
}

function UpdateText({ update }: { update: TaskUpdate }) {
  return update.note ? <CollapsibleText text={update.note} /> : null
}

export function UpdateEntry({
  update,
  index = 0,
  count = 1,
}: {
  update: TaskUpdate
  index?: number
  count?: number
}) {
  if (update.kind === 'decision') {
    return <Decisions updates={[update]} offset={index} total={count} />
  }

  if (update.kind === 'report') {
    return (
      <Disclosure
        className="update-fold report-fold"
        title={(
          <UpdateLine
            kind="report"
            at={update.at}
            plain
            title={(
              <>
                <span>{update.state}</span>
                <span className="update-fold-chevron" aria-hidden="true">
                  <Icon name="chevron_right" size={14} />
                </span>
              </>
            )}
          />
        )}
      >
        <UpdateText update={update} />
      </Disclosure>
    )
  }

  return (
    <UpdateLine
      kind={update.kind}
      icon={update.kind === 'link' ? linkIcon({ update }) : undefined}
      at={update.at}
      title={<UpdateTitle update={update} />}
    ><UpdateText update={update} />
    </UpdateLine>
  )
}

function Answer({ decision }: { decision: NonNullable<TaskUpdate['decision']> }) {
  if (!decision.answer) {
    return <p className="muted">{decision.ask?.to === 'hydra' ? 'Waiting for Hydra' : decision.ask ? 'Waiting for your answer' : 'Waiting for an answer'}</p>
  }

  const you = decision.actor === 'You'

  return (
    <div className="decision-answer">
      <UpdateIcon kind={you ? 'ask' : 'hydra'} label={`Answered by ${you ? 'you' : decision.actor}`} />
      <div className="decision-answer-text">
        {decision.choice && <CollapsibleText text={decision.choice} />}
        {decision.answer !== decision.choice && <CollapsibleText text={decision.answer} />}
      </div>
    </div>
  )
}

function AskParts({
  ask,
  choice,
}: {
  ask: NonNullable<NonNullable<TaskUpdate['decision']>['ask']>
  choice?: string
}) {
  const escalation = ask.escalation

  return (
    <>
      {ask.from && <p className="decision-from">{ask.from} asked {ask.from === 'Hydra' ? 'you' : 'Hydra'}</p>}
      {ask.context && <CollapsibleText text={ask.context} />}
      {!!ask.options?.length && (
        <ol className="decision-choices">
          {ask.options.map((
            option,
            i,
          ) => (
            <li key={option.label} aria-current={choice === option.label || undefined}>
              <CollapsibleText text={option.label} />
              {ask.recommended === i + 1 && <span className="decision-recommended">Recommended</span>}
              {option.description && <CollapsibleText className="muted" text={option.description} />}
            </li>
          ))}
        </ol>
      )}
      {escalation && (
        <div className="decision-escalation">
          <p className="decision-from">Hydra asked you</p>
          {escalation.reason && <CollapsibleText className="decision-from" text={escalation.reason} />}
          {escalation.question && <CollapsibleText className="decision-headline" text={escalation.question} />}
          {escalation.context && <CollapsibleText text={escalation.context} />}
        </div>
      )}
      {ask.details && (
        <Disclosure className="decision-details" title="Details">
          <CollapsibleText text={ask.details} />
        </Disclosure>
      )}
    </>
  )
}

function Decisions({
  updates,
  offset = 0,
  total = updates.length,
}: {
  updates: TaskUpdate[]
  offset?: number
  total?: number
}) {
  const many = total > 1

  return (
    <>
      <UpdateLine kind="decision" at={updates[0]!.at} title={many ? `${total} decisions` : 'Decision'} />
      <ol className="decision-list">
        {updates.map((
          update,
          index,
        ) => update.decision && (
          <li key={update.id}>
            <div className="decision-question">
              {many && <span className="decision-number">{offset + index + 1}</span>}
              <CollapsibleText className="decision-headline" text={update.decision.question} />
            </div>
            {update.decision.ask && (
              <AskParts
                ask={update.decision.ask}
                choice={update.decision.choice}
              />
            )}
            <Answer decision={update.decision} />
            {update.decision.reason && <CollapsibleText className="decision-why" text={update.decision.reason} />}
          </li>
        ))}
      </ol>
    </>
  )
}

function GroupHeading({
  group,
  open,
  controls,
  toggle,
}: {
  group: UpdateGroup
  open: boolean
  controls: string
  toggle(): void
}) {
  if (group.type === 'decisions') {
    return <UpdateLine kind="decision" at={group.updates[0]!.at} title={`${group.updates.length} decisions`} />
  }

  const workers = group.type === 'workers'
  const states = [...new Set(group.updates.map(update => stateLabel({ state: update.state })))].join(', ')

  return (
    <Button
      className="update-group-toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={toggle}
    >
      <UpdateLine
        kind={workers ? 'status' : 'renamed'}
        label={workers ? 'Worker updates' : 'Card changes'}
        at={group.updates.at(-1)!.at}
        plain
        title={(
          <>{group.updates.length} {workers ? 'worker updates' : 'card changes'} <span className="update-states">{states}</span>
            <span className="update-fold-chevron" aria-hidden="true"><Icon name="chevron_right" size={14} /></span>
          </>
        )}
      />
    </Button>
  )
}

// A click anywhere in an expandable row opens or closes all of it, never the card; selecting text does neither.
function toggleRow({ event }: { event: MouseEvent<HTMLLIElement> }) {
  const row = event.currentTarget
  const folds = [...row.querySelectorAll<HTMLDetailsElement>('details.update-fold')]
  const more = [...row.querySelectorAll<HTMLButtonElement>('.show-more')]

  if (!folds.length && !more.length && !row.classList.contains('update-decision')) {
    return
  }

  event.stopPropagation()

  if (window.getSelection()?.toString() || (event.target instanceof Element && event.target.closest('a, button, summary'))) {
    return
  }

  const expanded = ({ button }: { button: HTMLButtonElement }) => button.getAttribute('aria-expanded') === 'true'
  const open = folds.length
    ? folds.some(fold => fold.open)
    : more.some(button => expanded({ button }))
  folds.forEach(fold => {
    fold.open = !open
  })
  // Opening a fold shows its text clamped; closing a row also closes any text opened in it.
  const toggled = more.filter(button => open
    ? expanded({ button })
    : !folds.length && !expanded({ button }))
  toggled.forEach(button => button.click())
}

export function UpdateRow({
  update,
  group,
  index,
  prefix,
  open,
  toggle,
}: {
  update: TaskUpdate
  group: UpdateGroup
  index: number
  prefix: string
  open: boolean
  toggle(): void
}) {
  const folded = group.type === 'workers' || group.type === 'changes'
  const many = group.updates.length > 1
  const heading = index === 0 && (folded || (many && group.type === 'decisions'))
  const groupId = group.updates[0]!.id

  return (
    <li
      className={`update-row update-group-${group.type}${index ? ' update-group-continuation' : ''}${update.kind === 'decision' ? ' update-decision' : ''}`}
      data-update={update.id}
      data-update-group={groupId}
      data-update-group-end={index === group.updates.length - 1 || undefined}
      hidden={folded && !open && index > 0}
      onClick={event => {
        if (!folded) {
          return toggleRow({ event })
        }

        event.stopPropagation()

        if (!window.getSelection()?.toString() && !(event.target instanceof Element && event.target.closest('a, button, summary'))) {
          toggle()
        }
      }}
    >
      <div hidden={!heading}>
        {heading && (
          <GroupHeading
            group={group}
            open={open}
            controls={group.updates.map(update => `${prefix}:${update.id}`).join(' ')}
            toggle={toggle}
          />
        )}
      </div>
      <div id={`${prefix}:${update.id}`} className="update-entry" hidden={folded && !open}>
        <UpdateEntry update={update} index={index} count={group.updates.length} />
      </div>
    </li>
  )
}
