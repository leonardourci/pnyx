import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { PROVIDERS, providerIdOf } from '#workers/providers.ts'
import type { HydraState } from '#app/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { logDay, logged, type LogLine, type LogMode } from '#app/log-line.ts'
import { keptDays } from '#diagnostics/retention.ts'
import { HELPER_MODELS, type DoneAfterHours, type HelperSetting } from '#settings/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { columnsFor } from '#web-tasks/view.ts'

// The board preview draws a 1440 px screen this many times smaller.
const BOARD_SCALE = 0.175
const SCREEN = 1440
// The gaps and padding a real board spends beside the chat and between columns.
const CHAT_GAP = 20
const COLUMN_GAP = 12

function PreviewCard({
  variant = 'card',
  className = '',
  ...props
}: ComponentProps<'div'> & { variant?: 'card' | 'done' }) {
  const appearance = variant === 'done'
    ? 'flex-row justify-between py-1.5 text-meta transition-opacity ease-ui duration-base data-hidden:opacity-35 data-hidden:border-dashed'
    : 'flex-col py-2 border-t-3 border-t-blue text-ui'

  return <div {...props} className={`preview-card flex gap-1.25 max-w-80 px-2.25 border border-line rounded-md bg-surface ${appearance} ${className}`} />
}

function PreviewTitle({ ...props }: ComponentProps<'span'>) {
  return <span {...props} className="preview-card-title font-semibold leading-preview-title" />
}

function PreviewMeta({ ...props }: ComponentProps<'span'>) {
  return <span {...props} className="preview-card-meta flex items-center flex-wrap gap-1.5 text-muted text-meta" />
}

function PreviewChip({
  kind,
  ...props
}: ComponentProps<'span'> & { kind?: 'task' | 'skill' | 'command' | 'pr' }) {
  const appearance = {
    task: 'text-blue border-blue/35',
    skill: 'text-purple border-purple/35',
    command: 'text-teal border-teal/35 font-mono',
    pr: 'text-green border-green/35',
    plain: 'text-ink border-line',
  }[kind ?? 'plain']

  return <span {...props} data-kind={kind} className={`preview-chip inline-flex items-center gap-1 py-0 px-preview-chip rounded-full border bg-raised text-preview-chip leading-preview-chip whitespace-nowrap ${appearance}`} />
}

function PreviewConversation({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="preview-convo flex flex-col gap-1.5 text-ui" />
}

function PreviewBubble({
  owner = false,
  ...props
}: ComponentProps<'div'> & { owner?: boolean }) {
  const appearance = owner ? 'ml-6 bg-gold-wash border-gold-line' : 'bg-surface border-line'

  return <div {...props} data-from={owner ? 'owner' : undefined} className={`preview-bubble py-2 px-2.5 border rounded-lg leading-preview-bubble ${appearance}`} />
}

function PreviewTrace({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="preview-trace flex flex-wrap items-center gap-1 py-1 px-2 border border-dashed border-line rounded-md text-muted text-meta [&>pre]:basis-full [&>pre]:mt-1 [&>pre]:mx-0 [&>pre]:mb-0 [&>pre]:whitespace-pre-wrap [&>pre]:text-ink [&>pre]:text-meta" />
}

function MiniPanel({
  column = false,
  ...props
}: ComponentProps<'div'> & { column?: boolean }) {
  const appearance = column
    ? 'preview-board-column flex flex-col gap-0.75 p-0.75 border-subtle bg-background data-dragged:border-dashed data-dragged:border-muted [&>i]:block [&>i]:h-3.5 [&>i]:border [&>i]:border-line [&>i]:border-t-2 [&>i]:border-t-blue [&>i]:rounded-xs [&>i]:bg-surface'
    : 'preview-board-chat border-line bg-surface'

  return <div {...props} className={`relative shrink-0 rounded-preview transition-[width] ease-ui duration-base border ${appearance}`} />
}

function TimelineLabel({ ...props }: ComponentProps<'span'>) {
  return <span {...props} className="preview-timeline-label absolute top-9.5 -translate-x-1/2 text-muted text-meta whitespace-nowrap first-of-type:translate-x-0 data-end:-translate-x-full" />
}

function PreviewLane({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="preview-lane flex flex-col gap-0.75 py-1.75 px-2.25 border border-line rounded-control bg-surface text-muted data-on:border-gold [&>b]:inline-flex [&>b]:items-center [&>b]:gap-1.25 [&>b]:text-ink [&>b]:font-semibold" />
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
      <div className="setting-preview-box relative min-h-22.5 p-2.5 overflow-hidden border border-subtle rounded-lg bg-background">{children}</div>
      {caption && <p className="setting-preview-caption mt-1.5 mx-0 mb-0 text-muted text-meta">{caption}</p>}
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
  const dark = document.documentElement.dataset.theme === 'dark'
  const caption = `This page is ${dark ? 'dark' : 'light'} now${view.theme === 'system' ? ', following your computer' : ''}.`

  return (
    <Preview caption={caption}>
      <div className="preview-theme-tiles grid grid-cols-3 gap-2">
        {THEME_TILES.map(tile => (
          <button
            key={tile.value}
            type="button"
            className="preview-theme-tile relative h-16 p-0 border border-line rounded-md cursor-pointer data-[theme-tile=system]:bg-[linear-gradient(135deg,var(--color-tile-light)_50%,var(--color-tile-dark)_50%)] data-[theme-tile=light]:bg-tile-light data-[theme-tile=dark]:bg-tile-dark aria-pressed:outline-2 aria-pressed:outline-gold aria-pressed:outline-offset-1 [&>span]:absolute [&>span]:bottom-1 [&>span]:left-1.5 [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1 [&>span]:px-1.25 [&>span]:py-0 [&>span]:rounded-sm [&>span]:bg-surface [&>span]:text-ink [&>span]:text-meta"
            data-theme-tile={tile.value}
            aria-pressed={view.theme === tile.value}
            onClick={() => choose({ theme: tile.value })}
          >
            <span><Icon name={tile.icon} size={14} />{tile.label}</span>
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
      <PreviewCard style={{ fontSize: view.fontSize }}>
        <PreviewTitle >Add CSV export to reports</PreviewTitle>
        <PreviewMeta style={{ fontSize: detail }}>
          <Icon name="in_progress" size={12} /> In progress · <Icon name="claude-code" size={12} /> Claude Code · 12 min
        </PreviewMeta>
        <PreviewMeta style={{ fontSize: detail }}>
          <PreviewChip >build</PreviewChip>
          <PreviewChip kind="pr"><Icon name="github_pr" size={12} />PR #212</PreviewChip>
          <PreviewChip >atlas</PreviewChip>
        </PreviewMeta>
      </PreviewCard>
    </Preview>
  )
}

export function ChatTextPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <PreviewConversation style={{ fontSize: view.chatFontSize }}>
        <PreviewBubble owner>
          Ship <PreviewChip kind="task"><Icon name="task" size={12} />Add CSV export</PreviewChip> behind a flag, like
          {' '}<PreviewChip kind="pr"><Icon name="github_pr" size={12} />#198</PreviewChip>.
          {' '}Empty state: <span className="preview-image-chip inline-flex items-center gap-preview-image-gap h-preview-image-height pl-preview-image-left pr-preview-image-right py-0 border border-line rounded-preview-image bg-surface align-middle [&>span:first-child]:w-preview-thumbnail [&>span:first-child]:h-[1em] [&>span:first-child]:rounded-preview-thumbnail [&>span:first-child]:bg-[linear-gradient(135deg,var(--color-gold-wash),var(--color-blue))] [&>span:last-child]:text-preview-image"><span /><span>export-empty.png</span></span>
        </PreviewBubble>
        <PreviewBubble >
          On it with <PreviewChip kind="skill"><Icon name="skill" size={12} />pnyx-report-progress</PreviewChip>.
          {' '}Running <PreviewChip kind="command"><Icon name="terminal" size={12} />/test</PreviewChip> next.
        </PreviewBubble>
      </PreviewConversation>
    </Preview>
  )
}

export function CodeTextPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <pre className="preview-code m-0 py-2 px-2.5 rounded-md bg-raised font-mono whitespace-pre" style={{ fontSize: view.codeFontSize }}>{'pnyx-axi task start t-41 \\\n  --rule build'}</pre>
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

// The same widths drive the Hydra and the live Settings preview.
function boardWidths({
  state,
  view,
  dragged,
}: {
  state: HydraState
  view: ViewPreferences
  dragged: boolean
}): Widths {
  return {
    chat: dragged ? view.hydraWidth : view.defaultHydraWidth,
    columns: columnsFor({ state }).map(column => {
      const own = dragged ? view.columnWidths[column.id] : undefined

      return {
        id: column.id,
        width: own ?? view.defaultColumnWidths[column.id] ?? view.defaultColumnWidth,
        dragged: own !== undefined,
      }
    }),
  }
}

function MiniBoard({
  widths,
  mark,
}: {
  widths: Widths
  mark: 'columns' | 'chat' | 'none'
}) {
  const scaled = ({ px }: { px: number }): CSSProperties => ({ width: px * BOARD_SCALE })

  return (
    <div className="preview-board relative flex gap-0.75 h-23 p-0.75 overflow-hidden rounded-compact bg-raised [&_[data-marked]]:outline-2 [&_[data-marked]]:outline-gold [&_[data-marked]]:-outline-offset-1">
      <MiniPanel data-marked={mark === 'chat' || undefined} style={scaled({ px: widths.chat })} />
      {widths.columns.map(column => (
        <MiniPanel
          column
          key={column.id}
          data-marked={mark === 'columns' || undefined}
          data-dragged={column.dragged || undefined}
          style={scaled({ px: column.width })}
        >
          <i /><i />
        </MiniPanel>
      ))}
      <span className="preview-board-screen absolute top-0 bottom-0 w-0.5 bg-red opacity-70" style={{ left: SCREEN * BOARD_SCALE }} />
    </div>
  )
}

export function BoardPreview({
  state,
  view,
  mark,
}: {
  state: HydraState
  view: ViewPreferences
  mark: 'columns' | 'chat'
}) {
  const widths = boardWidths({
    state,
    view,
    dragged: true,
  })
  const fit = fitting({ widths }).toFixed(1)
  const caption = mark === 'columns'
    ? `On a 1440 px screen, ${fit} columns fit beside the chat.`
    : `A ${view.hydraWidth} px chat leaves room for ${fit} columns. The red line is the edge of a 1440 px screen.`

  return (
    <Preview caption={caption}>
      <MiniBoard widths={widths} mark={mark} />
    </Preview>
  )
}

export function CardUpdatesPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <PreviewCard >
        <PreviewTitle >Fix login redirect loop</PreviewTitle>
        <PreviewMeta ><Icon name="in_progress" size={12} /> In progress · <Icon name="codex" size={12} /> Codex · 4 min</PreviewMeta>
        {view.lastMessageOnCards && <span className="preview-card-latest pt-1 border-t border-subtle text-meta [&_b]:text-muted [&_b]:font-medium"><b>Latest:</b> Found it: the session cookie is set after the redirect. Writing the fix now.</span>}
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
            <Icon name="thinking" size={12} /> Thinking
            {view.thinkingDetails && <pre>{THINKING}</pre>}
          </PreviewTrace>
        )}
        {traces && (
          <PreviewTrace >
            <Icon name="tool" size={12} /> Ran <code>pnpm test reports</code>
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
  const caption = hours === 'off' ? 'Every Done card stays on the board.' : `${count} of ${DONE_CARDS.length} Done cards hidden.`

  return (
    <Preview caption={caption}>
      <div className="preview-done flex flex-col gap-1 max-w-80">
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

  const caption = minutes === 0 ? 'Timed reviews off. Hydra still wakes for messages and worker updates.'
    : minutes > TIMELINE_MINUTES ? `First review in ${minutes} min.` : `${ticks.length} reviews in the next 3 hours.`

  return (
    <Preview caption={caption}>
      <div className="preview-timeline relative h-13.5 mt-1 mx-2 mb-0">
        <span className="preview-timeline-axis absolute top-6 left-0 right-0 h-0.5 rounded-hairline bg-line" />
        {ticks.map(at => <span key={at} className="preview-timeline-tick absolute top-4 w-0.5 h-4.5 rounded-hairline bg-gold" style={{ left: `${at / TIMELINE_MINUTES * 100}%` }} />)}
        <TimelineLabel style={{ left: '0%' }}>now</TimelineLabel>
        <TimelineLabel style={{ left: '50%' }}>+1.5 h</TimelineLabel>
        <TimelineLabel data-end style={{ left: '100%' }}>+3 h</TimelineLabel>
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
      <div className="preview-log flex flex-col gap-0.75 max-w-90 [&>code]:py-0.75 [&>code]:px-2 [&>code]:border [&>code]:border-line [&>code]:rounded-md [&>code]:bg-surface [&>code]:text-meta [&>code]:wrap-anywhere [&>code]:transition-opacity [&>code]:ease-ui [&>code]:duration-base [&>code[data-detailed]]:border-gold/50 [&>code[data-hidden]]:opacity-35 [&>code[data-hidden]]:border-dashed">
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
      <div className="preview-days grid grid-cols-5 gap-1 max-w-90">
        {files.map(file => (
          <div key={file.name} className="preview-day flex flex-col gap-0.5 py-1 px-1.25 border border-line rounded-md bg-surface text-meta whitespace-nowrap transition-opacity ease-ui duration-base data-hidden:opacity-35 data-hidden:border-dashed" data-hidden={!file.kept || undefined}>
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
      <div className="preview-meter flex gap-0.25 h-3 mt-1.5 mx-0 mb-1 rounded-md bg-line overflow-hidden [&>span]:shrink-0 [&>span]:h-full [&>span]:bg-gold [&>span]:transition-[width] [&>span]:ease-ui [&>span]:duration-base" role="presentation">
        {kept.map(file => (
          <span
            key={file.name}
            style={{
              width: `${Math.min(
                file.size / maxMB,
                1,
              ) * 100}%`,
            }}
          />
        ))}
      </div>
      <p className="preview-meter-label text-muted text-meta">{`${used} of ${maxMB} MB`}</p>
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
  return <span className="preview-pill inline-flex items-center gap-1 justify-self-start max-w-full min-w-0 wrap-anywhere py-px px-2 border border-line rounded-full bg-surface whitespace-normal data-helper:border-gold/50 data-helper:text-gold" data-helper={helper || undefined}><Icon name={icon} size={12} />{label}</span>
}

export function HelperPreview({
  helper,
  hydra,
}: {
  helper: HelperSetting
  hydra: Partial<AgentConfig>
}) {
  const main = <Pill icon={providerIdOf({ harness: hydra.harness ?? 'claude' })} label={`Hydra · ${modelName({ agent: hydra })}`} />
  const routine = helper === 'off' ? main : (
    <Pill
      helper
      icon="helper"
      label={`Helper · ${helper === 'auto' ? HELPER_MODELS[hydra.harness ?? 'claude'] : modelName({ agent: helper })}`}
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
          <div key={what} className="preview-route-row grid grid-cols-[auto_minmax(0,1fr)] gap-y-1 gap-x-1.5 items-center [&>span:first-child]:col-span-full [&>span:first-child]:text-muted [&>svg]:text-muted">
            <span>{what}</span>
            <Icon name="arrow_right" size={12} />
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
          <b><Icon name="hydra" size={14} />Hydra, the orchestrator</b>
          <span>{details}</span>
        </PreviewLane>
        <PreviewLane >
          <b><Icon name="workers" size={14} />Workers</b>
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
  state: HydraState
  view: ViewPreferences
}) {
  const now = boardWidths({
    state,
    view,
    dragged: true,
  })
  const after = boardWidths({
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
      width: width * BOARD_SCALE,
    }
    left += width * BOARD_SCALE + 3

    return outline
  })

  return (
    <Preview caption={moved ? 'Dashed outlines: where Reset puts each pane.' : 'Widths match the saved settings.'}>
      <div className="preview-board-frame relative">
        <MiniBoard widths={now} mark="none" />
        {outlines.map(outline => <span key={outline.left} className="preview-board-ghost absolute top-0.75 bottom-0.75 border border-dashed border-gold rounded-preview pointer-events-none" style={outline} />)}
      </div>
    </Preview>
  )
}
