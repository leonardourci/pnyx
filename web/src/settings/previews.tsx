import { runtimeStyle } from '#web-shared/ui/runtime-style.ts'
import type { ComponentProps, ReactNode } from 'react'
import { PROVIDERS, providerIdOf } from '#workers/providers.ts'
import type { TitanState } from '#app/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { logDay, logged, type LogLine, type LogMode } from '#app/log-line.ts'
import { keptDays } from '#diagnostics/retention.ts'
import { HELPER_MODELS, type DoneAfterHours, type HelperSetting } from '#settings/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { projectWidth } from '#web-tasks/project-layout.ts'
import { columnsFor } from '#web-tasks/view.ts'

// The Titan preview draws a 1440 px screen this many times smaller.
const TITAN_SCALE = 0.175
const SCREEN = 1440
// The gaps and padding a real Titan spends beside the chat and between columns.
const CHAT_GAP = 20
const COLUMN_GAP = 12

function PreviewCard({
  variant = 'card',
  className = '',
  ...props
}: ComponentProps<'div'> & { variant?: 'card' | 'done' }) {
  const appearance = variant === 'done'
    ? 'flex-row justify-between py-1.5 text-meta transition-opacity duration-base ease-ui data-hidden:border-dashed data-hidden:opacity-35'
    : 'flex-col border-t-3 border-t-blue py-2 text-ui'

  return <div {...props} className={`preview-card flex max-w-80 gap-1.25 rounded-md border border-line bg-surface px-2.25 ${appearance} ${className}`} />
}

function PreviewTitle({ ...props }: ComponentProps<'span'>) {
  return <span {...props} className="preview-card-title leading-preview-title font-semibold" />
}

function PreviewMeta({ ...props }: ComponentProps<'span'>) {
  return <span {...props} className="preview-card-meta flex flex-wrap items-center gap-1.5 text-meta text-muted" />
}

function PreviewChip({
  kind,
  ...props
}: ComponentProps<'span'> & { kind?: 'task' | 'skill' | 'command' | 'pr' }) {
  const appearance = {
    task: 'border-blue/35 text-blue',
    skill: 'border-purple/35 text-purple',
    command: 'border-teal/35 font-mono text-teal',
    pr: 'border-green/35 text-green',
    plain: 'border-line text-ink',
  }[kind ?? 'plain']

  return <span {...props} data-kind={kind} className={`preview-chip inline-flex items-center gap-1 rounded-full border bg-raised px-preview-chip py-0 text-preview-chip leading-preview-chip whitespace-nowrap ${appearance}`} />
}

function PreviewConversation({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="preview-convo flex flex-col gap-1.5 text-ui" />
}

function PreviewBubble({
  owner = false,
  ...props
}: ComponentProps<'div'> & { owner?: boolean }) {
  const appearance = owner ? 'ml-6 border-gold-line bg-gold-wash' : 'border-line bg-surface'

  return <div {...props} data-from={owner ? 'owner' : undefined} className={`preview-bubble rounded-lg border px-2.5 py-2 leading-preview-bubble ${appearance}`} />
}

function PreviewTrace({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="preview-trace flex flex-wrap items-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-meta text-muted [&>pre]:mx-0 [&>pre]:mt-1 [&>pre]:mb-0 [&>pre]:basis-full [&>pre]:text-meta [&>pre]:whitespace-pre-wrap [&>pre]:text-ink" />
}

function MiniPanel({
  column = false,
  ...props
}: ComponentProps<'div'> & { column?: boolean }) {
  const appearance = column
    ? 'preview-titan-column flex flex-col gap-0.75 border-subtle bg-background p-0.75 data-dragged:border-dashed data-dragged:border-muted [&>i]:block [&>i]:h-3.5 [&>i]:rounded-xs [&>i]:border [&>i]:border-t-2 [&>i]:border-line [&>i]:border-t-blue [&>i]:bg-surface'
    : 'preview-titan-chat border-line bg-surface'

  return <div {...props} className={`relative shrink-0 rounded-preview border transition-width duration-base ease-ui ${appearance}`} />
}

function TimelineLabel({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  return <span {...props} className={`preview-timeline-label absolute top-9.5 -translate-x-1/2 text-meta whitespace-nowrap text-muted first-of-type:translate-x-0 data-end:-translate-x-full ${className}`} />
}

function PreviewLane({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="preview-lane flex flex-col gap-0.75 rounded-control border border-line bg-surface px-2.25 py-1.75 text-muted data-on:border-gold [&>b]:inline-flex [&>b]:items-center [&>b]:gap-1.25 [&>b]:font-semibold [&>b]:text-ink" />
}

function Preview({
  caption,
  children,
}: {
  caption?: string
  children: ReactNode
}) {
  return (
    <>
      <div className="setting-preview-box relative min-h-22.5 overflow-hidden rounded-lg border border-subtle bg-background p-2.5">{children}</div>
      {caption && <p className="setting-preview-caption mx-0 mt-1.5 mb-0 text-meta text-muted">{caption}</p>}
    </>
  )
}

const THEME_TILES = [
  {
    value: 'system',
    label: 'System',
    icon: 'theme-system',
  },
  {
    value: 'light',
    label: 'Light',
    icon: 'theme-light',
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: 'theme-dark',
  },
] as const

export function ThemePreview({
  view,
  choose,
}: {
  view: ViewPreferences
  choose({ theme }: { theme: ViewPreferences['theme'] }): void
}) {
  return (
    <Preview>
      <div className="preview-theme-tiles grid grid-cols-3 gap-2">
        {THEME_TILES.map(tile => (
          <button
            key={tile.value}
            type="button"
            className="preview-theme-tile relative h-16 cursor-pointer rounded-md border border-line p-0 aria-pressed:outline-2 aria-pressed:outline-offset-1 aria-pressed:outline-gold data-[theme-tile=dark]:bg-tile-dark data-[theme-tile=light]:bg-tile-light data-[theme-tile=system]:bg-preview-theme [&>span]:absolute [&>span]:bottom-1 [&>span]:left-1.5 [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1 [&>span]:rounded-sm [&>span]:bg-surface [&>span]:px-1.25 [&>span]:py-0 [&>span]:text-meta [&>span]:text-ink"
            data-theme-tile={tile.value}
            aria-pressed={view.theme === tile.value}
            onClick={() => choose({ theme: tile.value })}
          >
            <span><Icon name={tile.icon} size={ICON_SIZE.inline} />{tile.label}</span>
          </button>
        ))}
      </div>
    </Preview>
  )
}

export function CardTextPreview({ view }: { view: ViewPreferences }) {
  const detail = Math.round(view.fontSize * 6 / 7)

  return (
    <Preview caption={`${view.fontSize} px titles, ${detail} px details and tags`}>
      <PreviewCard style={runtimeStyle({ fontSize: view.fontSize })}>
        <PreviewTitle >Add CSV export to reports</PreviewTitle>
        <PreviewMeta style={runtimeStyle({ fontSize: detail })}>
          <Icon name="in_progress" size={ICON_SIZE.badge} /> In progress · <Icon name="claude-code" size={ICON_SIZE.badge} /> Claude Code · 12 min
        </PreviewMeta>
        <PreviewMeta style={runtimeStyle({ fontSize: detail })}>
          <PreviewChip >build</PreviewChip>
          <PreviewChip kind="pr"><Icon name="github_pr" size={ICON_SIZE.badge} />PR #212</PreviewChip>
          <PreviewChip >atlas</PreviewChip>
        </PreviewMeta>
      </PreviewCard>
    </Preview>
  )
}

export function ChatTextPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <PreviewConversation style={runtimeStyle({ fontSize: view.chatFontSize })}>
        <PreviewBubble owner>
          Ship <PreviewChip kind="task"><Icon name="task" size={ICON_SIZE.badge} />Add CSV export</PreviewChip> behind a flag, like
          {' '}<PreviewChip kind="pr"><Icon name="github_pr" size={ICON_SIZE.badge} />#198</PreviewChip>.
          {' '}Empty state: <span className="preview-image-chip inline-flex h-preview-image-height items-center gap-preview-image-gap rounded-preview-image border border-line bg-surface py-0 pr-preview-image-right pl-preview-image-left align-middle [&>span:first-child]:h-attachment-icon [&>span:first-child]:w-preview-thumbnail [&>span:first-child]:rounded-preview-thumbnail [&>span:first-child]:bg-preview-image [&>span:last-child]:text-preview-image"><span /><span>export-empty.png</span></span>
        </PreviewBubble>
        <PreviewBubble >
          On it with <PreviewChip kind="skill"><Icon name="skill" size={ICON_SIZE.badge} />othrys-report-progress</PreviewChip>.
          {' '}Running <PreviewChip kind="command"><Icon name="terminal" size={ICON_SIZE.badge} />/test</PreviewChip> next.
        </PreviewBubble>
      </PreviewConversation>
    </Preview>
  )
}

export function CodeTextPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <pre className="preview-code m-0 rounded-md bg-raised px-2.5 py-2 font-mono whitespace-pre" style={runtimeStyle({ fontSize: view.codeFontSize })}>{'othrys task create --title Build \\\n  --rule build'}</pre>
    </Preview>
  )
}

interface Widths {
  chat: number
  columns: {
    id: string
    width: number
    dragged: boolean
  }[]
}

const fitting = ({ widths }: { widths: Widths }) => {
  let room = SCREEN - widths.chat - CHAT_GAP
  let count = 0

  for (const column of widths.columns) {
    const needed = column.width + COLUMN_GAP

    if (room < needed) {
      return count + Math.max(
        0,
        room / needed,
      )
    }

    count++
    room -= needed
  }

  return count
}

// The same widths drive the Titan and the live Settings preview.
function titanWidths({
  state,
  view,
  dragged,
}: {
  state: TitanState
  view: ViewPreferences
  dragged: boolean
}): Widths {
  return {
    chat: dragged ? view.titanWidth : view.defaultTitanWidth,
    columns: columnsFor({ state }).map(column => {
      const own = dragged ? view.workspace.projectWidths[column.id] : undefined

      return {
        id: column.id,
        width: projectWidth({
          id: column.id,
          widths: dragged ? view.workspace.projectWidths : {},
          viewport: SCREEN,
        }).width,
        dragged: own !== undefined,
      }
    }),
  }
}

function MiniTitan({
  widths,
  mark,
}: {
  widths: Widths
  mark: 'columns' | 'chat' | 'none'
}) {
  return (
    <div className="preview-titan relative flex h-23 gap-0.75 overflow-hidden rounded-compact bg-raised p-0.75 [&_[data-marked]]:outline-2 [&_[data-marked]]:-outline-offset-1 [&_[data-marked]]:outline-gold">
      <MiniPanel data-marked={mark === 'chat' || undefined} style={runtimeStyle({ width: widths.chat * TITAN_SCALE })} />
      {widths.columns.map(column => (
        <MiniPanel
          column
          key={column.id}
          data-marked={mark === 'columns' || undefined}
          data-dragged={column.dragged || undefined}
          style={runtimeStyle({ width: column.width * TITAN_SCALE })}
        >
          <i /><i />
        </MiniPanel>
      ))}
      <span className="preview-titan-screen absolute top-0 bottom-0 w-0.5 bg-red opacity-70" style={runtimeStyle({ left: SCREEN * TITAN_SCALE })} />
    </div>
  )
}

export function TitanPreview({
  state,
  view,
  mark,
}: {
  state: TitanState
  view: ViewPreferences
  mark: 'columns' | 'chat'
}) {
  const widths = titanWidths({
    state,
    view,
    dragged: true,
  })
  const fit = fitting({ widths }).toFixed(1)
  const caption = mark === 'columns'
    ? `On a 1440 px screen, ${fit} columns fit beside the chat.`
    : `A ${view.titanWidth} px chat leaves room for ${fit} columns. The red line is the edge of a 1440 px screen.`

  return (
    <Preview caption={caption}>
      <MiniTitan widths={widths} mark={mark} />
    </Preview>
  )
}

export function CardUpdatesPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <PreviewCard >
        <PreviewTitle >Fix login redirect loop</PreviewTitle>
        <PreviewMeta ><Icon name="in_progress" size={ICON_SIZE.badge} /> In progress · <Icon name="codex" size={ICON_SIZE.badge} /> Codex · 4 min</PreviewMeta>
        {view.lastMessageOnCards && <span className="preview-card-latest border-t border-subtle pt-1 text-meta [&_b]:font-medium [&_b]:text-muted"><b>Latest:</b> Found it: the session cookie is set after the redirect. Writing the fix now.</span>}
      </PreviewCard>
    </Preview>
  )
}

const THINKING = 'The empty report path skips the header row, so the CSV has no columns…'

// open shows the conversation as Focus mode off would, so the tool and thinking switches have something to open.
export function ConversationPreview({
  view,
  open = false,
}: {
  view: ViewPreferences
  open?: boolean
}) {
  const traces = open || !view.focusMode
  const caption = view.focusMode ? open ? 'How it looks once Focus mode is off.' : 'Focus mode hides tool calls and thinking.' : undefined

  return (
    <Preview caption={caption}>
      <PreviewConversation >
        <PreviewBubble owner>Why does the export test fail?</PreviewBubble>
        {traces && (
          <PreviewTrace >
            <Icon name="thinking" size={ICON_SIZE.badge} /> Thinking
            {view.thinkingDetails && <pre>{THINKING}</pre>}
          </PreviewTrace>
        )}
        {traces && (
          <PreviewTrace >
            <Icon name="tool" size={ICON_SIZE.badge} /> Ran <code>pnpm test reports</code>
            {view.toolDetails && <pre>{'✓ 41 passed  ✗ 1 failed\n  export › empty report'}</pre>}
          </PreviewTrace>
        )}
        <PreviewBubble >The empty report skips its header row. Fixing it.</PreviewBubble>
      </PreviewConversation>
    </Preview>
  )
}

// Hours in Done for each synthetic card, so the preview shows which ones the delay would hide.
const DONE_CARDS = [
  {
    title: 'Rename settings route',
    hours: 0,
  },
  {
    title: 'Bump Vite',
    hours: 20,
  },
  {
    title: 'Fix flaky e2e',
    hours: 30,
  },
  {
    title: 'Upgrade Node',
    hours: 80,
  },
]

const age = ({ hours }: { hours: number }) => {
  if (hours === 0) {
    return 'just now'
  }

  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

export function DonePreview({ hours }: { hours: DoneAfterHours }) {
  const hidden = ({ card }: { card: typeof DONE_CARDS[number] }) => hours !== 'off' && card.hours >= hours
  const count = DONE_CARDS.filter(card => hidden({ card })).length
  const caption = hours === 'off' ? 'Every Done card stays on the Titan.' : `${count} of ${DONE_CARDS.length} Done cards hidden.`

  return (
    <Preview caption={caption}>
      <div className="preview-done flex max-w-80 flex-col gap-1">
        {DONE_CARDS.map(card => (
          <PreviewCard variant="done" key={card.title} data-hidden={hidden({ card }) || undefined}>
            <span>{card.title}</span>
            <PreviewMeta >{age({ hours: card.hours })}</PreviewMeta>
          </PreviewCard>
        ))}
      </div>
    </Preview>
  )
}

const TIMELINE_MINUTES = 180
const MAX_TICKS = 60

export function ReviewPreview({ minutes }: { minutes: number }) {
  const count = minutes > 0 ? Math.min(
    Math.floor(TIMELINE_MINUTES / minutes),
    MAX_TICKS,
  ) : 0
  const ticks = Array.from(
    { length: count },
    (
      _,
      index,
    ) => (index + 1) * minutes,
  )

  const caption = minutes === 0 ? 'Timed reviews off. Titan still wakes for messages and worker updates.'
    : minutes > TIMELINE_MINUTES ? `First review in ${minutes} min.` : `${ticks.length} reviews in the next 3 hours.`

  return (
    <Preview caption={caption}>
      <div className="preview-timeline relative mx-2 mt-1 mb-0 h-13.5">
        <span className="preview-timeline-axis absolute top-6 right-0 left-0 h-0.5 rounded-hairline bg-line" />
        {ticks.map(at => <span key={at} className="preview-timeline-tick absolute top-4 h-4.5 w-0.5 rounded-hairline bg-gold" style={runtimeStyle({ left: `${at / TIMELINE_MINUTES * 100}%` })} />)}
        <TimelineLabel className="left-0">now</TimelineLabel>
        <TimelineLabel className="left-1/2">+1.5 h</TimelineLabel>
        <TimelineLabel data-end className="left-full">+3 h</TimelineLabel>
      </div>
    </Preview>
  )
}

// Example lines at each level, shown or dimmed by the same rule the loggers use.
const LOG_LINES: {
  text: string
  line: Pick<LogLine, 'level' | 'detailed'>
}[] = [
  {
    text: '12:04:31 command.page 38 ms',
    line: {},
  },
  {
    text: '12:04:33 thread.live 2 ms',
    line: { detailed: true },
  },
  {
    text: '12:04:33 page.frame 17 ms',
    line: { detailed: true },
  },
  {
    text: '12:04:39 turn.end 8.2 s',
    line: {},
  },
  {
    text: '12:05:00 process 212 MB',
    line: {},
  },
  {
    text: '12:05:02 warn follow.read',
    line: { level: 'warn' },
  },
]

const LOG_CAPTIONS: Record<LogMode, string> = {
  off: 'Only warnings and errors are written.',
  on: 'One line per action, with its duration and the server’s memory.',
  detailed: 'Adds a line for every live chat update and frame. Switch back to On once the debugging is done.',
}

export function LogLinesPreview({ mode }: { mode: LogMode }) {
  return (
    <Preview caption={LOG_CAPTIONS[mode]}>
      <div className="preview-log flex max-w-90 flex-col gap-0.75 [&>code]:rounded-md [&>code]:border [&>code]:border-line [&>code]:bg-surface [&>code]:px-2 [&>code]:py-0.75 [&>code]:text-meta [&>code]:wrap-anywhere [&>code]:transition-opacity [&>code]:duration-base [&>code]:ease-ui [&>code[data-detailed]]:border-gold/50 [&>code[data-hidden]]:border-dashed [&>code[data-hidden]]:opacity-35">
        {LOG_LINES.map(({
          text,
          line,
        }) => {
          const hidden = !logged({
            mode,
            line,
          }) || undefined
          const detailed = line.detailed || undefined

          return (
            <code key={text} data-hidden={hidden} data-detailed={detailed}>
              {text}
            </code>
          )
        })}
      </div>
    </Preview>
  )
}

const BYTES_PER_MB = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
// Ten example days of logs in MB, newest first: one detailed debugging day among ordinary ones.
const LOG_DAY_SIZES = [
  6,
  5,
  7,
  240,
  6,
  5,
  4,
  6,
  5,
  7,
]

const dayName = ({ index }: { index: number }) => index === 0 ? 'Today' : `${index} d ago`

// The example days as a cleanup sees them, ending today, and which of them it keeps.
function exampleDays({
  days,
  maxMB,
}: {
  days: number
  maxMB: number
}) {
  const now = Date.now()
  const files = LOG_DAY_SIZES.map((
    size,
    index,
  ) => ({
    name: dayName({ index }),
    size,
    day: logDay({ at: new Date(now - index * DAY_MS).toISOString() }),
    bytes: size * BYTES_PER_MB,
  }))
  const retained = keptDays({
    days: files,
    keepDays: days,
    maxBytes: maxMB * BYTES_PER_MB,
    today: files[0]!.day,
  })

  return {
    files: files.map(file => ({
      ...file,
      kept: retained.kept.has(file.day),
    })),
    full: files[0]!.size > maxMB,
  }
}

export function LogDaysPreview({
  days,
  maxMB,
}: {
  days: number
  maxMB: number
}) {
  const { files } = exampleDays({
    days,
    maxMB,
  })
  const count = files.filter(file => file.kept).length
  const caption = `${count} of ${files.length} example days kept; the rest are deleted.`

  return (
    <Preview caption={caption}>
      <div className="preview-days grid max-w-90 grid-cols-5 gap-1">
        {files.map(file => (
          <div key={file.name} className="preview-day flex flex-col gap-0.5 rounded-md border border-line bg-surface px-1.25 py-1 text-meta whitespace-nowrap transition-opacity duration-base ease-ui data-hidden:border-dashed data-hidden:opacity-35" data-hidden={!file.kept || undefined}>
            <span>{file.name}</span>
            <PreviewMeta >{file.size} MB</PreviewMeta>
          </div>
        ))}
      </div>
    </Preview>
  )
}

export function LogSizePreview({
  days,
  maxMB,
}: {
  days: number
  maxMB: number
}) {
  const {
    files,
    full,
  } = exampleDays({
    days,
    maxMB,
  })
  const kept = files.filter(file => file.kept)
  const used = kept.reduce(
    (
      sum,
      file,
    ) => sum + file.size,
    0,
  )
  const caption = full
    ? 'Today alone is past the limit, so it takes only warnings and errors until tomorrow.'
    : 'Each kept example day takes its share of the limit. Past it, the oldest day goes first.'

  return (
    <Preview caption={caption}>
      <div className="preview-meter mx-0 mt-1.5 mb-1 flex h-3 gap-0.25 overflow-hidden rounded-md bg-line [&>span]:h-full [&>span]:shrink-0 [&>span]:bg-gold [&>span]:transition-width [&>span]:duration-base [&>span]:ease-ui" role="presentation">
        {kept.map(file => (
          <span
            key={file.name}
            style={runtimeStyle({
              width: `${Math.min(
                file.size / maxMB,
                1,
              ) * 100}%`,
            })}
          />
        ))}
      </div>
      <p className="preview-meter-label text-meta text-muted">{`${used} of ${maxMB} MB`}</p>
    </Preview>
  )
}

const harnessName = ({ agent }: { agent: Partial<AgentConfig> }) => PROVIDERS[agent.harness ?? 'claude'].name
const agentName = ({ agent }: { agent: Partial<AgentConfig> }) =>
  `${harnessName({ agent })}${agent.model ? ` · ${agent.model}` : ''}`
// The pills name only the model, since their icon already shows the harness.
const modelName = ({ agent }: { agent: Partial<AgentConfig> }) =>
  agent.model ?? harnessName({ agent })

function Pill({
  icon,
  label,
  helper = false,
}: {
  icon: string
  label: string
  helper?: boolean
}) {
  return <span className="preview-pill inline-flex max-w-full min-w-0 items-center gap-1 justify-self-start rounded-full border border-line bg-surface px-2 py-px wrap-anywhere whitespace-normal data-helper:border-gold/50 data-helper:text-gold" data-helper={helper || undefined}><Icon name={icon} size={ICON_SIZE.badge} />{label}</span>
}

export function HelperPreview({
  helper,
  titan,
}: {
  helper: HelperSetting
  titan: Partial<AgentConfig>
}) {
  const main = <Pill icon={providerIdOf({ harness: titan.harness ?? 'claude' })} label={`Titan · ${modelName({ agent: titan })}`} />
  const routine = helper === 'off' ? main : (
    <Pill
      helper
      icon="helper"
      label={`Helper · ${helper === 'auto' ? HELPER_MODELS[titan.harness ?? 'claude'] : modelName({ agent: helper })}`}
    />
  )
  const rows: [string, ReactNode][] = [
    [
      'Routine wakes',
      routine,
    ],
    [
      'Your messages',
      main,
    ],
    [
      'Questions and reviews',
      main,
    ],
  ]

  return (
    <Preview>
      <div className="preview-route grid gap-2.5 text-meta">
        {rows.map(([
          what,
          who,
        ]) => (
          <div key={what} className="preview-route-row grid grid-cols-icon-content items-center gap-x-1.5 gap-y-1 [&>span:first-child]:col-span-full [&>span:first-child]:text-muted [&>svg]:text-muted">
            <span>{what}</span>
            <Icon name="arrow_right" size={ICON_SIZE.badge} />
            {who}
          </div>
        ))}
      </div>
    </Preview>
  )
}

export function AgentPreview({ agent }: { agent: Partial<AgentConfig> }) {
  const details = [
    agentName({ agent }),
    agent.effort,
    agent.mode,
    agent.fast ? 'fast' : undefined,
  ].filter(Boolean).join(' · ')

  return (
    <Preview>
      <div className="preview-lanes grid gap-1.5 text-meta">
        <PreviewLane data-on>
          <b><Icon name="titan" size={ICON_SIZE.inline} />Titan, the orchestrator</b>
          <span>{details}</span>
        </PreviewLane>
        <PreviewLane >
          <b><Icon name="workers" size={ICON_SIZE.inline} />Workers</b>
          <span>Picked per task by heads dispatch, not by this setting.</span>
        </PreviewLane>
      </div>
    </Preview>
  )
}

export function ResetPreview({
  state,
  view,
}: {
  state: TitanState
  view: ViewPreferences
}) {
  const now = titanWidths({
    state,
    view,
    dragged: true,
  })
  const after = titanWidths({
    state,
    view,
    dragged: false,
  })
  const moved = now.chat !== after.chat || now.columns.some((
    column,
    index,
  ) => column.width !== after.columns[index]?.width)
  let left = 3
  const outlines = [
    after.chat,
    ...after.columns.map(column => column.width),
  ].map(width => {
    const outline = {
      left,
      width: width * TITAN_SCALE,
    }
    left += width * TITAN_SCALE + 3

    return outline
  })

  return (
    <Preview caption={moved ? 'Dashed outlines: where Reset puts each pane.' : 'Widths match the saved settings.'}>
      <div className="preview-titan-frame relative">
        <MiniTitan widths={now} mark="none" />
        {outlines.map(outline => <span key={outline.left} className="preview-titan-ghost pointer-events-none absolute top-0.75 bottom-0.75 rounded-preview border border-dashed border-gold" style={runtimeStyle(outline)} />)}
      </div>
    </Preview>
  )
}
