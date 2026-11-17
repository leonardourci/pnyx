import { QUESTION_HEADLINE, QUESTION_SOURCE, RecommendedBadge } from '#web-shared/ui/question-panel.tsx'
import { DisclosureChevron } from '#web-shared/ui/disclosure-chevron.tsx'
import type { MouseEvent, ReactNode } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'
import { CollapsibleText, Disclosure } from '#web-shared/ui/disclosure.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { Tooltip } from '#web-shared/ui/tooltip.tsx'
import { LINK_ICONS, LinkChip } from './card-links.tsx'
import type { TaskUpdate, UpdateKind } from '#tasks/updates.ts'
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
  state === 'paused' ? 'Worker note' : state === 'needs_you' ? 'Needs you' : state.replace(
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
  const tones: Partial<Record<UpdateKind, string>> = {
    ask: 'text-gold bg-gold-wash',
    decision: 'text-gold bg-gold-wash',
    hydra: 'text-teal bg-update-hydra',
    told: 'text-blue bg-update-told',
    link: 'text-purple bg-update-link',
    done: 'text-green bg-update-done',
  }
  const appearance = tones[kind] ?? 'text-muted bg-raised'

  return (
    <Tooltip content={label}>
      <span className={`update-icon update-icon-${kind} inline-flex items-center justify-center size-5.5 rounded-md ${appearance}`} role="img" aria-label={label}><Icon name={icon} size={ICON_SIZE.inline} /></span>
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
    <div className="update-line grid grid-cols-[1.375rem_minmax(0,1fr)] gap-2 items-start [&+.update-line]:mt-1.5">
      <UpdateIcon kind={kind} icon={icon} label={label} />
      <div className="update-main grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.75 items-baseline min-w-0 [&>:is(time,.tooltip-anchor)]:col-start-2 [&>:is(time,.tooltip-anchor)]:row-start-1 [&>:not(time,.tooltip-anchor)]:col-span-full [&>.update-title]:col-start-1 [&>.update-title]:col-end-auto [&>.update-title]:row-start-1 [&_time]:text-muted [&_time]:text-meta [&_time]:leading-5.5 [&_time]:whitespace-nowrap">
        {at && <UpdateTime at={at} plain={plain} />}
        {title && <div className="update-title font-semibold leading-5.5 wrap-anywhere [&_.card-link]:py-0 [&_.card-link]:leading-4.5 [&_.card-link]:align-[1px] in-[.update-decision]:text-gold">{title}</div>}
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
    return <Decision update={update} index={index} count={count} />
  }

  if (update.kind === 'report') {
    return (
      <Disclosure
        className="update-fold report-fold [&>summary]:pr-0 [&>summary>.disclosure-chevron]:hidden [&>.disclosure-body]:grid [&>.disclosure-body]:gap-1.5 [&>.disclosure-body]:pt-1.5 [&>.disclosure-body]:pl-7.5"
        title={({ open }) => (
          <UpdateLine
            kind="report"
            at={update.at}
            plain
            title={(
              <>
                <span>{update.state}</span>
                <span className="update-fold-chevron inline-flex h-3.5 ml-1 align-[-2px] text-muted" aria-hidden="true">
                  <DisclosureChevron expanded={open} size={14} />
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
    <div className="decision-answer grid grid-cols-[1.375rem_minmax(0,1fr)] gap-1.5 items-start">
      <UpdateIcon kind={you ? 'ask' : 'hydra'} label={`Answered by ${you ? 'you' : decision.actor}`} />
      <div className="decision-answer-text grid gap-0.5 min-w-0">
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
      {ask.from && <p className={QUESTION_SOURCE}>{ask.from} asked {ask.from === 'Hydra' ? 'you' : 'Hydra'}</p>}
      {ask.context && <CollapsibleText text={ask.context} />}
      {!!ask.options?.length && (
        <ol className="decision-choices m-0 pl-4.5 grid gap-0.5 [&>li[aria-current]]:text-gold [&>li[aria-current]]:font-semibold">
          {ask.options.map((
            option,
            i,
          ) => (
            <li key={option.label} aria-current={choice === option.label || undefined}>
              <CollapsibleText text={option.label} />
              {ask.recommended === i + 1 && <RecommendedBadge />}
              {option.description && <CollapsibleText className="muted" text={option.description} />}
            </li>
          ))}
        </ol>
      )}
      {escalation && (
        <div className="decision-escalation grid gap-1 pl-2 border-l-2 border-line">
          <p className={QUESTION_SOURCE}>Hydra asked you</p>
          {escalation.reason && (
            <CollapsibleText className={QUESTION_SOURCE} text={escalation.reason} />
          )}
          {escalation.question && (
            <CollapsibleText className={QUESTION_HEADLINE} text={escalation.question} />
          )}
          {escalation.context && <CollapsibleText text={escalation.context} />}
        </div>
      )}
      {ask.details && (
        <Disclosure className="decision-details [&>summary]:text-muted [&>summary]:text-meta" title="Details">
          <CollapsibleText text={ask.details} />
        </Disclosure>
      )}
    </>
  )
}

function Decision({
  update,
  index,
  count,
}: {
  update: TaskUpdate
  index: number
  count: number
}) {
  const many = count > 1

  return (
    <>
      <UpdateLine kind="decision" at={update.at} title={many ? `${count} decisions` : update.state} />
      <ol className="decision-list list-none mt-1.5 mr-0 mb-0 ml-7.5 p-0 grid gap-2 [&>li]:grid [&>li]:gap-1 [&>li]:py-0.5 [&>li]:pr-0 [&>li]:pl-2.5 [&>li]:border-l-2 [&>li]:border-gold-line">
        {update.decision && (
          <li key={update.id}>
            <div className="decision-question flex gap-1.5 items-baseline min-w-0 [&>.collapsible-text]:min-w-0">
              {many && <span className="decision-number inline-flex items-center justify-center shrink-0 min-w-4.5 h-4.5 rounded-full bg-gold-wash text-gold text-meta">{index + 1}</span>}
              <CollapsibleText className={QUESTION_HEADLINE} text={update.decision.question} />
            </div>
            {update.decision.ask && (
              <AskParts
                ask={update.decision.ask}
                choice={update.decision.choice}
              />
            )}
            <Answer decision={update.decision} />
            {update.decision.reason && <CollapsibleText className="decision-why text-muted text-meta" text={update.decision.reason} />}
          </li>
        )}
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
      className="update-group-toggle block w-full text-left p-0 whitespace-normal"
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
          <>{group.updates.length} {workers ? 'worker updates' : 'card changes'} <span className="update-states text-muted text-meta font-normal">{states}</span>
            <span className="update-fold-chevron inline-flex h-3.5 ml-1 align-[-2px] text-muted" aria-hidden="true"><DisclosureChevron expanded={open} size={14} /></span>
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
      className={`update-row py-2 px-1 border-b border-subtle transition-colors duration-fast ease-ui last:border-b-0 first:pt-1.5 [&:is(.update-decision,:has(.update-fold,.update-group-toggle,.show-more)):hover]:rounded-md [&:is(.update-decision,:has(.update-fold,.update-group-toggle,.show-more)):hover]:bg-hover/55 hover:[&_.update-fold-chevron]:text-ink motion-reduce:transition-none [&:not([data-update-group-end]):not(:has(.update-group-toggle[aria-expanded=false]))]:border-b-0 [&.update-group-continuation]:pt-0 [&:is(.update-group-workers,.update-group-changes)>.update-entry]:pt-1.5 [&:is(.update-group-workers,.update-group-changes)>.update-entry]:pl-7.5 [&.update-group-decisions>.update-entry>.update-line]:hidden [&.update-group-moment.update-group-continuation_.update-icon]:hidden [&.update-group-moment.update-group-continuation_.update-main>.tooltip-anchor:has(time)]:hidden [&.update-group-moment.update-group-continuation_.update-main]:col-start-2 update-group-${group.type}${index ? ' update-group-continuation' : ''}${update.kind === 'decision' ? ' update-decision' : ''}`}
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
      <div id={`${prefix}:${update.id}`} className="update-entry " hidden={folded && !open}>
        <UpdateEntry update={update} index={index} count={group.updates.length} />
      </div>
    </li>
  )
}
