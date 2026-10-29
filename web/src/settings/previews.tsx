import type { CSSProperties, ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { HELPER_MODELS, type DoneAfterHours, type HelperSetting } from '#settings/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { DEFAULT_COLUMN_WIDTH } from '#preferences/view.ts'
import { Icon } from '#web-shared/ui/icon.tsx'
import { columnsFor } from '#web-tasks/view.ts'

// The board preview draws a 1440 px screen this many times smaller.
const BOARD_SCALE = 0.3
const SCREEN = 1440
// The gaps and padding a real board spends beside the chat and between columns.
const CHAT_GAP = 20
const COLUMN_GAP = 12

function Preview({
  caption,
  children,
}: {
  caption?: string
  children: ReactNode
}) {
  return (
    <>
      <div className="setting-preview-box">{children}</div>
      {caption && <p className="setting-preview-caption">{caption}</p>}
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
      <div className="preview-theme-tiles">
        {THEME_TILES.map(tile => (
          <button
            key={tile.value}
            type="button"
            className="preview-theme-tile"
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
      <div className="preview-card" style={{ fontSize: view.fontSize }}>
        <span className="preview-card-title">Add CSV export to reports</span>
        <span className="preview-card-meta" style={{ fontSize: detail }}>
          <Icon name="in_progress" size={12} /> In progress · <Icon name="claude-code" size={12} /> Claude Code · 12 min
        </span>
        <span className="preview-card-meta" style={{ fontSize: detail }}>
          <span className="preview-chip">build</span>
          <span className="preview-chip" data-kind="pr"><Icon name="github_pr" size={12} />PR #212</span>
          <span className="preview-chip">atlas</span>
        </span>
      </div>
    </Preview>
  )
}

export function ChatTextPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <div className="preview-convo" style={{ fontSize: view.chatFontSize }}>
        <div className="preview-bubble" data-from="owner">
          Ship <span className="preview-chip" data-kind="task"><Icon name="task" size={12} />Add CSV export</span> behind a flag, like
          {' '}<span className="preview-chip" data-kind="pr"><Icon name="github_pr" size={12} />#198</span>.
          {' '}Empty state: <span className="preview-image-chip"><span /><span>export-empty.png</span></span>
        </div>
        <div className="preview-bubble">
          On it with <span className="preview-chip" data-kind="skill"><Icon name="skill" size={12} />pnyx-report-progress</span>.
          {' '}Running <span className="preview-chip" data-kind="command"><Icon name="terminal" size={12} />/test</span> next.
        </div>
      </div>
    </Preview>
  )
}

export function CodeTextPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <pre className="preview-code" style={{ fontSize: view.codeFontSize }}>{'pnyx-axi task start t-41 \\\n  --rule build'}</pre>
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

// Dragged widths are this Hydra's own; the defaults apply where a column was never dragged.
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
    chat: dragged && state.view?.hydraWidth ? view.hydraWidth : view.defaultHydraWidth,
    columns: columnsFor({ state }).map(column => {
      const own = dragged ? state.view?.columnWidths?.[column.id] : undefined

      return {
        id: column.id,
        width: own ?? view.defaultColumnWidths[column.id] ?? DEFAULT_COLUMN_WIDTH,
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
    <div className="preview-board">
      <div className="preview-board-chat" data-marked={mark === 'chat' || undefined} style={scaled({ px: widths.chat })} />
      {widths.columns.map(column => (
        <div
          key={column.id}
          className="preview-board-column"
          data-marked={(mark === 'columns' && !column.dragged) || undefined}
          data-dragged={column.dragged || undefined}
          style={scaled({ px: column.width })}
        >
          <i /><i />
        </div>
      ))}
      <span className="preview-board-screen" style={{ left: SCREEN * BOARD_SCALE }} />
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
    dragged: mark === 'columns',
  })
  const fit = fitting({ widths }).toFixed(1)
  const caption = mark === 'columns'
    ? `On a 1440 px screen, ${fit} columns fit beside the chat. Dashed columns were dragged in this Hydra and keep their width.`
    : `A ${view.defaultHydraWidth} px chat leaves room for ${fit} columns at their defaults. The red line is the edge of a 1440 px screen.`

  return (
    <Preview caption={caption}>
      <MiniBoard widths={widths} mark={mark} />
    </Preview>
  )
}

export function CardUpdatesPreview({ view }: { view: ViewPreferences }) {
  return (
    <Preview>
      <div className="preview-card">
        <span className="preview-card-title">Fix login redirect loop</span>
        <span className="preview-card-meta"><Icon name="in_progress" size={12} /> In progress · <Icon name="codex" size={12} /> Codex · 4 min</span>
        {view.lastMessageOnCards && <span className="preview-card-latest"><b>Latest:</b> Found it: the session cookie is set after the redirect. Writing the fix now.</span>}
      </div>
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
      <div className="preview-convo">
        <div className="preview-bubble" data-from="owner">Why does the export test fail?</div>
        {traces && (
          <div className="preview-trace">
            <Icon name="thinking" size={12} /> Thinking
            {view.thinkingDetails && <pre>{THINKING}</pre>}
          </div>
        )}
        {traces && (
          <div className="preview-trace">
            <Icon name="tool" size={12} /> Ran <code>pnpm test reports</code>
            {view.toolDetails && <pre>{'✓ 41 passed  ✗ 1 failed\n  export › empty report'}</pre>}
          </div>
        )}
        <div className="preview-bubble">The empty report skips its header row. Fixing it.</div>
      </div>
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
      <div className="preview-done">
        {DONE_CARDS.map(card => (
          <div key={card.title} className="preview-card" data-hidden={hidden({ card }) || undefined}>
            <span>{card.title}</span>
            <span className="preview-card-meta">{age({ hours: card.hours })}</span>
          </div>
        ))}
      </div>
    </Preview>
  )
}

// Three hours of review ticks at the chosen cadence.
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
      <div className="preview-timeline">
        <span className="preview-timeline-axis" />
        {ticks.map(at => <span key={at} className="preview-timeline-tick" style={{ left: `${at / TIMELINE_MINUTES * 100}%` }} />)}
        <span className="preview-timeline-label" style={{ left: '0%' }}>now</span>
        <span className="preview-timeline-label" style={{ left: '50%' }}>+1.5 h</span>
        <span className="preview-timeline-label" data-end style={{ left: '100%' }}>+3 h</span>
      </div>
    </Preview>
  )
}

const agentName = ({ agent }: { agent: Partial<AgentConfig> }) => `${agent.harness === 'codex' ? 'Codex' : 'Claude Code'}${agent.model ? ` · ${agent.model}` : ''}`

function Pill({
  icon,
  label,
  helper = false,
}: {
  icon: string
  label: string
  helper?: boolean
}) {
  return <span className="preview-pill" data-helper={helper || undefined}><Icon name={icon} size={12} />{label}</span>
}

export function HelperPreview({
  helper,
  hydra,
}: {
  helper: HelperSetting
  hydra: Partial<AgentConfig>
}) {
  const main = <Pill icon={hydra.harness === 'codex' ? 'codex' : 'claude-code'} label={`Hydra · ${agentName({ agent: hydra })}`} />
  const routine = helper === 'off' ? main : (
    <Pill
      helper
      icon="helper"
      label={`Helper · ${helper === 'auto' ? HELPER_MODELS[hydra.harness ?? 'claude'] : agentName({ agent: helper })}`}
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
      <div className="preview-route">
        {rows.map(([
          what,
          who,
        ]) => (
          <div key={what} className="preview-route-row">
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
      <div className="preview-lanes">
        <div className="preview-lane" data-on>
          <b><Icon name="hydra" size={14} />Hydra, the orchestrator</b>
          <span>{details}</span>
        </div>
        <div className="preview-lane">
          <b><Icon name="workers" size={14} />Workers</b>
          <span>Picked per task by heads dispatch, not by this setting.</span>
        </div>
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
  const moved = now.chat !== after.chat || now.columns.some(column => column.dragged)
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
    <Preview caption={moved ? 'Dashed outlines: where Reset puts each pane.' : 'Nothing is dragged in this Hydra; every pane already sits at its default.'}>
      <div className="preview-board-frame">
        <MiniBoard widths={now} mark="none" />
        {outlines.map(outline => <span key={outline.left} className="preview-board-ghost" style={outline} />)}
      </div>
    </Preview>
  )
}
