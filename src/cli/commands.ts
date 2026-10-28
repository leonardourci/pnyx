import { upgradeCommand } from '../upgrade/model.ts'
import { columnRule, parseColumnRule } from '../core/columns.ts'
import { lifecycleMoves } from '../core/lifecycle.ts'
import { checkWorkerNotes, workerNotesNotice } from '../memory/workers.ts'
import { resolveSkillReferences } from '../thread/skill-reference.ts'
import { effectiveDispatch } from '../dispatch/config.ts'
import { requireSetupHome } from '../setup/home.ts'
import { setupCheckOutput } from '../setup/check.ts'
import { mentionContext, REFERENCE, referenceLabel } from '../mentions/mentions.ts'
import { IMAGE, imageNames } from '../attachments/images.ts'
import { FILE_BLOCK } from '../attachments/files.ts'
import { reminderTime } from '../reminders/time.ts'
import { projectRows, projectsFor } from '../projects/read.ts'
import { MAX_DONE_HOURS } from '../core/retention.ts'
import { hideDone } from '../store/retention.ts'
import { setupService } from '../server/service.ts'
import { setupSkills } from '../integrations/skills/install.ts'
import { checkBudget, HYDRA_MEMORY_BUDGET, OWNER_DOCUMENTS } from '../memory/budgets.ts'
import { randomUUID } from 'node:crypto'
import { sendReply } from './reply.ts'
import { findSession, liveTask, rankOf, selfSession } from '../core/tasks.ts'
import { setupHydra, startHydra, taskPrompt } from './start.ts'
import { OVERRIDE_FIELDS, overrideOf, type Override } from '../dispatch/select.ts'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { hydraConfig, hydraEvent, HYDRA_CARD, LOCKED_DELETE, lockedColumn, hydraDelivery, reportActor, validateColumns } from '../core/hydra.ts'
import type { HydraConfig, HydraIdentity } from '../core/model.ts'
import { isDeepStrictEqual } from 'node:util'
import { AxiError } from 'axi-sdk-js'
import type { Meta } from '../app/command-meta.ts'
import { decideView } from '../preferences/decisions.ts'
import { decideLink, decideMove, decideOutcome, decidePush, findCard, parseLink } from '../core/decide.ts'
import { type HydraEvent, type HydraState } from '../app/model.ts'
import { HYDRA_ACTOR, ownerActor } from '../app/actors.ts'
import { HydraError } from '../store/errors.ts'
import { OUTCOME_STATES, type Card, type Column, type NotedEvent, type OutcomeState } from '../core/model.ts'
import { askHost, readServer, socketPath } from '../app/server-state.ts'
import { detectedHarnesses, setupHooks } from '../integrations/hooks/install.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { appendNote, harvestTranscripts } from '../integrations/hooks/harvest.ts'
import { answerPrompt } from '../core/answer.ts'
import { tagsTask } from '../core/updates.ts'
import { HARNESSES, type Harness } from '../integrations/hooks/observe.ts'
import { pullRequestNote } from '../integrations/github/pull-request.ts'
import { canonical } from '../store/paths.ts'
import { DEFAULT_HYDRA, hydraDir, hydraIds } from '../app/home-migration.ts'
import { loadHydra } from '../app/store.ts'
import { readEvents } from '../app/event-log.ts'
import { withWriter } from '../app/writer.ts'
import { spoolFiles } from '../store/storage.ts'
import { HISTORY_LIMIT, HISTORY_MAX, HOME_LIMIT, TEXT_CUT, COMMON, WRITE, parse, required, integer, meta, explained, commit, guard, clip, type Output, type Options, summarize } from '../app/cli-support.ts'
import { memoryList, memoryChange } from '../memory/cli.ts'

function column({ value }: { value: string }): Column {
  return (value.startsWith('custom:') ? value : value.replace(
    /-/g,
    '_',
  )) as Column
}

// A task records an attached project by path; rows show its name, and every row has the field
// so lists stay tabular.
function projectName({
  state,
  project,
}: {
  state: HydraState
  project?: string | null
}): string {
  return project ? projectsFor({ state }).find(p => p.path === project)?.name ?? project : 'none'
}

export function attentionLabel({ card }: { card: Card }) {
  const kinds = card.attention.map(a => a.kind)

  return kinds.length > 0 ? kinds.join(' ') : 'none'
}

export function cardRow({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) {
  return {
    id: card.id,
    title: card.title,
    project: projectName({
      state,
      project: card.project,
    }),
    column: card.column,
  }
}

function cardDetail({
  state,
  card,
  full,
}: {
  state: HydraState
  card: Card
  full: boolean
}): Output {
  const detail: Output = {
    id: card.id,
    key: card.key,
    title: card.title,
    project: projectName({
      state,
      project: card.project,
    }),
    workspace: card.workspace,
    column: card.column,
    tags: card.tags.length ? card.tags : 'none',
  }

  if (card.brief !== undefined) {
    detail.brief = full ? card.brief : clip({ text: card.brief })
  }

  if (card.parentId) {
    detail.parent = card.parentId
  }

  if (card.activity) {
    detail.activity = card.activity
  }

  if (card.agent) {
    detail.agent = card.agent
  }

  detail.sessions = card.sessionIds?.length ? card.sessionIds : 'none'
  detail.visibility = card.hidden ? 'history' : 'hydra'
  detail.hideAfterHours = card.doneAfterHours ?? 'Hydra setting'

  if (card.settings) {
    detail.settings = card.settings
  }

  detail.permissions = card.permissions?.length ? card.permissions : 'none'
  detail.attention = card.attention.length ? card.attention : 'none'
  detail.links = card.links.length
    ? card.links.map(l => ({
      kind: l.kind,
      number: l.number ?? '',
      title: l.title ?? '',
      state: l.state ?? 'unknown',
      url: l.url,
    }))
    : 'none'

  if (card.outcome) {
    detail.outcome = card.outcome
  }

  if (card.replies?.length) {
    detail.replies = card.replies
  }

  detail.revision = card.revision
  detail.updated = card.updatedAt

  return detail
}

export async function home(): Promise<Output> {
  hideDone({ hydraId: DEFAULT_HYDRA })
  const {
    dir,
    state,
    tornBytes,
  } = loadHydra({ hydraId: DEFAULT_HYDRA })
  const cards = Object.values(state.cards).filter(card => liveTask({ card }))
  const config = hydraConfig({ state })
  const columns = Object.fromEntries(
    config.columns.map(c => [
      c.id,
      cards.filter(card => card.column === c.id).length,
    ]),
  )
  const server = await readServer({ hydraId: DEFAULT_HYDRA })
  const out: Output = {
    projects: projectRows({ state }),
    hydraId: DEFAULT_HYDRA,
    hydra: config.hydra.id,
    server: server ? `running at ${server.url}` : 'not running',
    columns,
  }

  if (tornBytes > 0) {
    out.warning = 'events.jsonl has a torn tail; run `pnyx-axi repair`'
  }

  const serveHint = server ? [] : ['Run `pnyx-axi serve` to start the Hydra server']
  const spooled = spoolFiles({ dir }).length

  if (spooled > 0) {
    out.spool = `${spooled} hook events waiting; the next write ingests them`
  }

  if (cards.length === 0) {
    out.cards = 'none: no cards yet'
    out.help = [
      'Run `pnyx-axi task create --title <title>` to add work',
      ...serveHint,
    ]

    return out
  }

  const order = ({ c }: { c: Card }) => config.columns.findIndex(column => column.id === c.column)
  const sorted = cards.sort((
    a,
    b,
  ) => order({
    c: a,
  }) - order({
    c: b,
  }) || rankOf({ card: a }) - rankOf({ card: b }))
  out.cards = sorted.slice(
    0,
    HOME_LIMIT,
  ).map(card => cardRow({
    state,
    card,
  }))
  out.help = [
    'Run `pnyx-axi card <id>` for details',
    'Run `pnyx-axi history` for recent events',
    ...serveHint,
  ]

  if (sorted.length > HOME_LIMIT) {
    out.more = `${sorted.length - HOME_LIMIT} more cards not shown`
  }

  return out
}

export const CONTEXT_TASKS = 5

// The session-start hook's summary: the Hydra's open work for the attached project holding the
// session's folder, kept short because it loads into every session there. Elsewhere it prints nothing.
export const context = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        cwd: { type: 'string' },
      },
      positionals: 0,
    })
    const folder = canonical({ path: String(values.cwd ?? process.cwd()) })
    const { state } = loadHydra({ hydraId })
    const project = folder ? projectsFor({ state }).find(p => !p.detached
      && (folder === p.path || folder.startsWith(`${p.path}/`))) : undefined

    if (!project) {
      return {}
    }

    const done = new Set(hydraConfig({ state }).columns.filter(c => c.role === 'done').map(c => c.id))
    const open = Object.values(state.cards).filter(card => liveTask({ card })
      && card.project === project.path && !done.has(card.column))
      .sort((
        a,
        b,
      ) => rankOf({ card: a }) - rankOf({ card: b }))
    // The server's socket file, not a health request: the hook never waits on the network.
    const server = existsSync(socketPath({ hydraId }))

    return {
      pnyx: `Hydra ${hydraId}, project ${project.name}, server ${server ? 'running' : 'not running'}`,
      count: `${Math.min(
        open.length,
        CONTEXT_TASKS,
      )} of ${open.length} open tasks`,
      tasks: open.length ? open.slice(
        0,
        CONTEXT_TASKS,
      ).map(card => ({
        id: card.id,
        title: card.title,
        column: card.column,
      })) : 'none: no open tasks for this project',
      help: [
        `Run \`pnyx-axi task list --hydra ${hydraId}\` for every task`,
        `Run \`pnyx-axi card <id> --hydra ${hydraId}\` for one task`,
      ],
    }
  },
})

export const push = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        key: { type: 'string' },
        file: { type: 'string' },
      },
      positionals: 0,
    })
    const m = meta({ values })
    const key = required({
      value: values.key as string | undefined,
      what: '--key',
    })
    const file = required({
      value: values.file as string | undefined,
      what: '--file',
    })
    let input: unknown

    try {
      input = JSON.parse(readFileSync(
        file === '-' ? 0 : file,
        'utf8',
      ))
    } catch (error) {
      throw new AxiError(
        `cannot read card JSON from ${file}: ${(error as Error).message}`,
        'VALIDATION_ERROR',
      )
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.pushed',
        card: key,
      },
      decide: ({ state }) => decidePush({
        state,
        key,
        input,
        meta: m,
      }),
    })
  },
})

export function startOverride({
  values,
}: {
  values: Record<string, unknown>
}): Override | undefined {
  const { fast } = values

  if (fast !== undefined && fast !== 'on' && fast !== 'off') {
    throw new HydraError({
      message: '--fast takes on or off',
      code: 'VALIDATION_ERROR',
    })
  }

  const named = OVERRIDE_FIELDS.filter(name => name !== 'fast' && values[name] !== undefined)
  const empty = named.find(name => !String(values[name]).trim())

  if (empty) {
    throw new HydraError({
      message: `--${empty} needs a value`,
      code: 'VALIDATION_ERROR',
    })
  }

  return overrideOf({
    value: Object.fromEntries([
      ...named.map(name => [
        name,
        values[name],
      ]),
      ...(fast === undefined ? [] : [
        [
          'fast',
          fast === 'on',
        ],
      ]),
    ]),
  })
}

// A paused worker's --until takes the same times as a reminder.
export function untilTime({
  until,
  now,
}: {
  until?: string
  now: string
}): string | undefined {
  if (until === undefined) {
    return undefined
  }

  return reminderTime({
    when: until,
    now,
  })
}

export const TASK_FIELDS = [
  'attention',
  'parent',
  'status',
  'worker',
  'hold',
  'queue',
] as const
export type TaskField = (typeof TASK_FIELDS)[number]

// `task list --fields status,worker` adds those fields to the default id, title, project and column.
export function taskFields({ value }: { value?: string }): TaskField[] {
  const fields = (value ?? '').split(',').map(field => field.trim())
    .filter(Boolean)
  const unknown = fields.filter(field => !TASK_FIELDS.includes(field as TaskField))

  if (unknown.length) {
    throw new AxiError(
      `unknown field: ${unknown.join(', ')}`,
      'VALIDATION_ERROR',
      [`Use --fields with any of ${TASK_FIELDS.join(', ')}`],
    )
  }

  return fields as TaskField[]
}

type Attachment = Extract<HydraEvent, { type: 'task.session' }>
export type TaskCreated = Extract<HydraEvent, { type: 'task.created' }>

// Attachment is durable even when delivery fails.
export async function afterAttach({
  hydraId,
  result,
  attachment,
  meta,
}: {
  hydraId: string
  result: Output
  attachment: Attachment
  meta: Meta
}): Promise<Output> {
  if (!attachment.data.brief) {
    return result
  }

  const state = loadHydra({ hydraId }).state
  const home = state.config?.hydra.home

  try {
    const brief = await sendReply({
      hydraId,
      request: {
        card: attachment.cardId,
        text: taskPrompt({
          hydraId,
          card: state.cards[attachment.cardId]!,
        }),
        expectedSession: attachment.data.session,
        homes: home ? [home] : [],
        actor: meta.actor,
        id: `brief:${attachment.id}`,
      },
    })

    return {
      ...result,
      brief,
    }
  } catch (error) {
    return {
      ...result,
      brief: {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      help: ['The attachment was recorded; inspect the task before retrying its brief with the same --event-id'],
    }
  }
}

export function taskBrief({ value }: { value: unknown }): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.length > 24000) {
    throw new HydraError({
      message: 'a brief must be text of up to 24000 characters',
      code: 'VALIDATION_ERROR',
    })
  }

  return value
}

export function sessionRef({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): string {
  return ref === 'self'
    ? selfSession({
      state,
      here: {
        paseoTerminal: process.env.PASEO_TERMINAL_ID,
        tmuxPane: process.env.TMUX_PANE,
        herdrPane: process.env.HERDR_PANE_ID,
      },
    }).id
    : ref
}

export function taskHistory({
  hydraId,
  ref,
  before,
  limit,
  full,
}: {
  hydraId: string
  ref: string
  before?: number
  limit: number
  full: boolean
}): Output {
  if (limit < 1 || limit > HISTORY_MAX) {
    throw new HydraError({
      message: `limit must be 1–${HISTORY_MAX}`,
      code: 'VALIDATION_ERROR',
    })
  }

  const state = loadHydra({ hydraId }).state
  const task = findCard({
    state,
    ref,
  })
  const ids = new Set([
    task.id,
    ...Object.values(state.cards).filter(c => c.parentId === task.id)
      .map(c => c.id),
  ])
  const events = readEvents({ hydraId })
  const sessions = taskSessions({
    hydraId,
    ids,
  })
  const matches = events.filter(e => (before === undefined || e.seq < before) && (ids.has(e.cardId) || (e.type === 'task.session' && (ids.has(e.data.before ?? '') || ids.has(e.data.after ?? ''))) || tagsTask({
    event: e,
    ids,
  })))
    .reverse()
  const page = matches.slice(
    0,
    limit,
  )

  const help = [
    ...(matches.length > limit ? [`Run \`pnyx-axi task history ${ref} --before ${page.at(-1)!.seq} --hydra ${hydraId}\` for older events`] : []),
    ...(full || !page.length ? [] : [`Run \`pnyx-axi task history ${ref} --full --hydra ${hydraId}\` for each event's data`]),
  ]

  return {
    hydraId,
    task: task.id,
    sessions: sessions.size ? [...sessions].map(id => ({
      session: id,
      transcript: state.sessions?.[id]?.agent.transcriptPath ?? 'unavailable',
      command: `pnyx-axi task chat ${task.id} --session ${id} --hydra ${hydraId}`,
    })) : 'none: no agent has worked on this task',
    events: page.length ? page.map(e => ({
      seq: e.seq,
      id: e.id,
      at: e.at,
      type: e.type,
      card: e.cardId,
      actor: e.actor,
      summary: summarize({ event: e }),
      ...(full ? {
        data: e.data,
        reason: e.reason,
        details: e.details,
      } : {}),
    })) : 'none: no matching events',
    ...(matches.length > limit ? { next: page.at(-1)!.seq } : {}),
    ...(help.length ? { help } : {}),
  }
}

export function taskSessions({
  hydraId,
  ids,
}: {
  hydraId: string
  ids: Set<string>
}): Set<string> {
  const sessions = new Set<string>()

  for (const event of readEvents({ hydraId })) {
    if (event.type === 'task.session' && (ids.has(event.data.before ?? '') || ids.has(event.data.after ?? ''))) {
      sessions.add(event.data.session)
    }

    if (ids.has(event.cardId) && event.type === 'card.pushed' && event.data.agent) {
      const agent = event.data.agent
      sessions.add(`${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`)
    }
  }

  return sessions
}

function hydraConfigCommand({ args }: { args: string[] }): Output {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      name: { type: 'string' },
      identity: { type: 'string' },
      session: { type: 'string' },
      firstmate: { type: 'string' },
      command: { type: 'string' },
      'command-folder': { type: 'string' },
      base: { type: 'string' },
      'done-after-hours': { type: 'string' },
      'review-minutes': { type: 'string' },
      helper: { type: 'string' },
      'helper-model': { type: 'string' },
      'helper-effort': { type: 'string' },
    },
    positionals: 2,
  })
  const action = positionals[0]

  if (action === 'homes') {
    return firstmateHomes({ base: values.base as string | undefined })
  }

  if (action === 'list') {
    const hydras = hydraIds()

    if (!hydras.length) {
      return {
        hydras: 'none: no Hydras yet',
        help: ['Run `pnyx-axi hydra create <id>` to add one'],
      }
    }

    return {
      hydras: hydras.map(id => {
        hideDone({ hydraId: id })
        const state = loadHydra({ hydraId: id }).state
        const config = hydraConfig({
          state,
          id,
        })

        const tasks = Object.values(state.cards).filter(c => liveTask({ card: c })).length

        return {
          id,
          name: config.name,
          hydra: config.hydra.id,
          kind: config.hydra.kind,
          tasks,
        }
      }),
      help: ['Run `pnyx-axi hydra show --hydra <id>` for its columns and Hydra'],
    }
  }

  const id = action !== 'create'
    ? hydraId
    : positionals[1]
      ?? (values.firstmate ? homeHydraId({ home: String(values.firstmate) }) : required({
        value: undefined,
        what: 'Hydra id',
      }))
  hydraDir({ hydraId: id })

  if (action === 'show') {
    const state = loadHydra({ hydraId: id }).state

    return {
      hydra: hydraConfig({
        state,
        id,
      }),
      projects: projectRows({ state }),
      revision: state.configRevision ?? 0,
    }
  }

  if (action !== 'create' && action !== 'set') {
    throw new HydraError({
      message: 'Use hydra create <id>, list, homes, show or set',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })

  return commit({
    hydraId: id,
    create: action === 'create',
    meta: m,
    intent: {
      type: 'board.configured',
      card: '$board',
    },
    decide: ({ state }) => {
      const current = hydraConfig({
        state,
        id,
      })

      if (action === 'create' && !state.config && !Object.keys(state.cards).length) {
        current.columns = current.columns.map(c => ({
          ...c,
          id: `custom:${randomUUID()}`,
        }))
      }

      const identity = String(values.identity ?? current.hydra.id)
      required({
        value: identity.trim(),
        what: '--identity',
      })
      const kept = identity === current.hydra.id ? current.hydra : undefined
      const home = canonical({ path: values.firstmate })

      if (values.firstmate && !home) {
        throw new HydraError({
          message: '--firstmate must be an absolute home path',
          code: 'VALIDATION_ERROR',
        })
      }

      const session = values.session ? findSession({
        state,
        ref: sessionRef({
          state,
          ref: String(values.session),
        }),
      }) : undefined

      if (session && session.taskId && !state.cards[session.taskId]?.automaticTask) {
        throw new HydraError({
          message: 'detach the task worker before making it Hydra',
          code: 'CONFLICT',
        })
      }

      const hydra: HydraIdentity = {
        name: 'Hydra',
        kind: 'agent',
        ...kept,
        id: identity,
        ...(home ? {
          kind: 'firstmate',
          home,
        } : {}),
        ...(session ? { session: session.id } : {}),
      }

      const command = values.command === undefined ? current.command : String(values.command).trim()
      const data: HydraConfig = {
        ...current,
        id,
        name: String(values.name ?? current.name),
        hydra,
      }

      if (values['done-after-hours'] !== undefined) {
        const raw = String(values['done-after-hours']).trim()
        const hours = Number(raw)

        if (!raw || !Number.isFinite(hours) || hours < 0 || hours > MAX_DONE_HOURS) {
          throw new HydraError({
            message: `--done-after-hours must be a number from 0 to ${MAX_DONE_HOURS} (0 keeps Done cards visible)`,
            code: 'VALIDATION_ERROR',
          })
        }

        data.doneAfterHours = hours
      }

      if (values.helper !== undefined || values['helper-model'] !== undefined || values['helper-effort'] !== undefined) {
        const harness = values.helper ?? (current.helper && current.helper.harness) ?? current.hydra.agent?.harness ?? 'claude'

        if (harness === 'off') {
          data.helper = false
        } else if (harness === 'auto') {
          delete data.helper
        } else if (harness === 'claude' || harness === 'codex') {
          let previous: Exclude<typeof current.helper, false>

          if (current.helper && current.helper.harness === harness) {
            previous = current.helper
          }

          data.helper = {
            harness,
            model: String(values['helper-model'] ?? previous?.model ?? (harness === 'claude' ? 'sonnet' : 'gpt-6-luna')),
          }
          const effort = values['helper-effort'] ?? previous?.effort

          if (effort !== undefined) {
            data.helper.effort = String(effort)
          }
        } else {
          throw new HydraError({
            message: '--helper takes auto, off, claude or codex',
            code: 'VALIDATION_ERROR',
          })
        }
      }

      if (values['review-minutes'] !== undefined) {
        const minutes = Number(values['review-minutes'])

        if (!String(values['review-minutes']).trim() || !Number.isFinite(minutes) || minutes < 0
          || minutes * 60_000 > 2_147_483_647) {
          throw new HydraError({
            message: '--review-minutes must be a non-negative number within the timer range (0 turns reviews off)',
            code: 'VALIDATION_ERROR',
          })
        }

        data.reviewMinutes = minutes
      }

      delete data.command

      if (command) {
        data.command = command
      }

      const owns = values['command-folder']

      if (owns !== undefined && owns !== 'own' && owns !== 'copy') {
        throw new HydraError({
          message: '--command-folder must be own or copy',
          code: 'VALIDATION_ERROR',
        })
      }

      if (owns === 'own') {
        data.commandOwnsFolder = true
      } else if (owns === 'copy') {
        delete data.commandOwnsFolder
      }

      // Creating a Hydra that already exists as asked is a no-op; other settings need hydra set.
      if (action === 'create' && state.configured) {
        if (isDeepStrictEqual(
          data,
          hydraConfig({
            state,
            id,
          }),
        )) {
          return { skipped: 'unchanged' }
        }

        throw new HydraError({
          message: `Hydra already exists with other settings: ${id}`,
          code: 'CONFLICT',
          help: [`Run \`pnyx-axi hydra set --hydra ${id}\` with the settings to change`],
        })
      }

      return hydraEvent({
        state,
        meta: m,
        cardId: '$board',
        change: {
          type: 'board.configured',
          data,
        },
      })
    },
  })
}

const HYDRA_NAME_MAX = 40

export function hydraName({ text }: { text: string }): string | undefined {
  const lines = text.replace(
    FILE_BLOCK,
    '',
  ).replace(
    new RegExp(
      REFERENCE.source,
      'g',
    ),
    (
      _,
      label: string,
    ) => referenceLabel({ label }),
  )
    .split('\n')
    .map(part => part.trim())
  const index = lines.findIndex(part => part.replace(
    IMAGE,
    '',
  ).trim())

  if (index < 0) {
    return undefined
  }

  const names = imageNames({ text })
  const line = lines[index]!.replace(
    IMAGE,
    (
      _,
      path: string,
    ) => names.get(path) ?? 'Image',
  )

  if (line.length <= HYDRA_NAME_MAX) {
    return line
  }

  // An early space would leave a word or two, so the cut falls mid-word, never inside a surrogate pair.
  const cut = line.slice(
    0,
    HYDRA_NAME_MAX + 1,
  )
  const space = cut.lastIndexOf(' ')
  const end = space >= HYDRA_NAME_MAX / 2 ? space : HYDRA_NAME_MAX
  const words = cut.slice(
    0,
    end,
  ).replace(
    /[\uD800-\uDBFF]$/,
    '',
  )
    .replace(
      /[\s,.;:!?-]+$/,
      '',
    )

  return words ? `${words}…` : undefined
}

function nameHydra({
  hydraId,
  meta,
  text,
}: {
  hydraId: string
  meta: Meta
  text: string
}): void {
  const name = hydraName({ text })

  if (!name) {
    return
  }

  // A retried message retries its naming under the same derived id.
  const naming: Meta = {
    at: meta.at,
    actor: meta.actor,
  }

  if (meta.id) {
    naming.id = `${meta.id}:name`
  }

  try {
    commit({
      hydraId,
      meta: naming,
      intent: {
        type: 'board.configured',
        card: '$board',
      },
      decide: ({
        state,
        meta,
      }) => {
        const config = hydraConfig({
          state,
          id: hydraId,
        })

        return config.name ? { skipped: 'unchanged' } : hydraEvent({
          state,
          meta,
          cardId: '$board',
          change: {
            type: 'board.configured',
            data: {
              ...config,
              name,
            },
          },
        })
      },
    })
  } catch (error) {
    // The message has landed; a busy log only delays the name to the owner's next message.
    if (!(error instanceof HydraError && error.code === 'LOCKED')) {
      throw error
    }
  }
}

function homeHydraId({ home }: { home: string }): string {
  return basename(home).toLowerCase()
    .replace(
      /[^a-z0-9._-]+/g,
      '-',
    )
    .replace(
      /^[^a-z0-9]+/,
      '',
    )
    .slice(
      0,
      64,
    ) || 'firstmate'
}

function firstmateHomes({ base }: { base?: string }): Output {
  const root = base ?? process.env.FIRSTMATE_FACTORY_BASE

  if (!root) {
    throw new AxiError(
      'missing --base',
      'VALIDATION_ERROR',
      ['Run `pnyx-axi hydra homes --base <folder holding the homes>`, or set FIRSTMATE_FACTORY_BASE'],
    )
  }

  let names: string[] = []

  try {
    names = readdirSync(
      root,
      { withFileTypes: true },
    ).filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { /* No such folder: no homes. */ }

  const homes = names.map(name => join(
    root,
    name,
  )).filter(path =>
    [
      'state',
      'config',
    ].every(dir => existsSync(join(
      path,
      dir,
    ))) && existsSync(join(
      path,
      'bin',
      'fm-send.sh',
    )))
  let hydras: {
    id: string
    home?: string
  }[] = []

  try {
    hydras = hydraIds().map(id => ({
      id,
      home: loadHydra({ hydraId: id }).state.config?.hydra.home,
    }))
  } catch { /* An unreadable Hydra links no home. */ }

  if (!homes.length) {
    return {
      base: root,
      homes: 'none: no Firstmate homes found',
      help: ['Pass --base <folder holding the homes>'],
    }
  }

  const rows = homes.map(home => {
    const real = canonical({ path: home }) ?? home
    const hydraId = hydras.find(b => b.home === real)?.id

    return {
      home: real,
      hydraId: hydraId ?? 'none',
      ...(hydraId ? {} : { create: `pnyx-axi hydra create --firstmate ${real}` }),
    }
  })

  return {
    base: root,
    homes: rows,
    help: ['Each home gets its own Hydra; run the create command of a home without one'],
  }
}

function columnCommand({ args }: { args: string[] }): Output {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      title: { type: 'string' },
      description: { type: 'string' },
      width: { type: 'string' },
      when: {
        type: 'string',
        multiple: true,
      },
      clear: { type: 'boolean' },
      id: { type: 'string' },
      to: { type: 'string' },
      before: { type: 'string' },
    },
    positionals: 2,
  })
  const action = positionals[0]

  if (action === 'list') {
    const state = loadHydra({ hydraId }).state

    return {
      columns: hydraConfig({
        state,
        id: hydraId,
      }).columns.map(column => ({
        ...column,
        rule: columnRule({ column }),
      })),
      revision: state.configRevision ?? 0,
    }
  }

  const m = meta({ values })

  if (action === 'rule' && !m.reason?.trim()) {
    throw new HydraError({
      message: 'column rule needs --reason <why>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'resize') {
    const ref = required({
      value: positionals[1],
      what: 'column id',
    })
    const width = integer({
      value: values.width,
      flag: '--width',
    })

    if (width === undefined) {
      throw new HydraError({
        message: 'pass --width <pixels>',
        code: 'VALIDATION_ERROR',
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => {
        if (!hydraConfig({
          state,
          id: hydraId,
        }).columns.some(c => c.id === ref)) {
          throw new HydraError({
            message: `column not found: ${ref}`,
            code: 'NOT_FOUND',
          })
        }

        return decideView({
          state,
          patch: { columnWidths: { [ref]: width } },
          meta: m,
        })
      },
    })
  }

  let confirmation: { token?: string } | undefined
  const changesPlacement = action === 'delete' || action === 'reorder' || action === 'rule'

  if (m.actor !== 'web' && changesPlacement) {
    confirmation = { token: values.confirm as string | undefined }
  }

  return commit({
    hydraId,
    meta: m,
    confirmation,
    intent: {
      type: 'board.columns',
      card: '$board',
    },
    decide: ({ state }) => {
      const before = structuredClone(hydraConfig({
        state,
        id: hydraId,
      }).columns)
      let columns = structuredClone(before)
      const ref = positionals[1]
      const selected = columns.find(c => c.id === ref || c.role === ref)

      if (action !== 'create' && !selected) {
        throw new HydraError({
          message: `column not found: ${ref}`,
          code: 'NOT_FOUND',
        })
      }

      if (action === 'delete' && lockedColumn({
        state,
        id: selected!.id,
      })) {
        throw new HydraError({
          message: LOCKED_DELETE,
          code: 'VALIDATION_ERROR',
        })
      }

      let fallback: Column | undefined

      if (action === 'create') {
        const id = String(values.id ?? `custom:${randomUUID()}`)

        if (!/^custom:[a-z0-9-]{1,60}$/.test(id)) {
          throw new HydraError({
            message: 'new column ids use custom:<letters-digits-dashes>',
            code: 'VALIDATION_ERROR',
          })
        }

        columns.push({
          id: id as Column,
          title: required({
            value: values.title as string,
            what: '--title',
          }),
          description: String(values.description ?? ''),
          rule: [],
        })
      } else if (action === 'rule') {
        const when = values.when as string[] | undefined ?? []

        if ((!values.clear && !when.length) || (values.clear && when.length)) {
          throw new HydraError({
            message: 'pass --when <fact[,fact]> (repeat for OR), or --clear for manual placement',
            code: 'VALIDATION_ERROR',
          })
        }

        selected!.rule = parseColumnRule({ when })
      } else if (action === 'rename') {
        selected!.title = required({
          value: values.title as string,
          what: '--title',
        })
      } else if (action === 'describe') {
        if (typeof values.description !== 'string') {
          throw new HydraError({
            message: 'pass --description <text> (empty text clears it)',
            code: 'VALIDATION_ERROR',
          })
        }

        selected!.description = values.description
      } else if (action === 'delete') {
        columns = columns.filter(c => c.id !== selected!.id)
        fallback = values.to
          ? columns.find(c => c.id === values.to || c.role === values.to)?.id : columns[0]?.id

        if (values.to && !fallback) {
          throw new HydraError({
            message: 'fallback column not found',
            code: 'VALIDATION_ERROR',
          })
        }
      } else if (action === 'reorder') {
        columns = columns.filter(c => c.id !== selected!.id)
        const index = values.before
          ? columns.findIndex(c => c.id === values.before || c.role === values.before)
          : columns.length

        if (index < 0) {
          throw new HydraError({
            message: '--before column not found',
            code: 'VALIDATION_ERROR',
          })
        }

        columns.splice(
          index,
          0,
          selected!,
        )

        if (columns.every((
          c,
          i,
        ) => c.id === before[i]!.id)) {
          return { skipped: 'unchanged' }
        }
      } else {
        throw new HydraError({
          message: 'Use column list, create, rename, describe, rule, resize, delete or reorder',
          code: 'VALIDATION_ERROR',
        })
      }

      validateColumns({ columns })

      if (isDeepStrictEqual(
        columns,
        before,
      )) {
        return { skipped: 'unchanged' }
      }

      const gone = ({ id }: { id?: Column }) =>
        id !== undefined && !columns.some(column => column.id === id)
      const placements = Object.fromEntries(Object.values(state.cards)
        .filter(c => gone({ id: c.column }))
        .map(c => [
          c.id,
          {
            before: c.column,
            after: fallback ?? columns[0]!.id,
          },
        ]))

      if (changesPlacement) {
        const config = hydraConfig({
          state,
          id: hydraId,
        })
        const proposed = {
          ...state,
          config: {
            ...config,
            columns,
          },
        }

        for (const move of lifecycleMoves({
          before: state,
          state: proposed,
        })) {
          if (placements[move.cardId]) {
            continue
          }

          placements[move.cardId] = {
            before: state.cards[move.cardId]!.column,
            after: move.column,
          }
        }
      }

      return hydraEvent({
        state,
        meta: m,
        cardId: '$board',
        change: {
          type: 'board.columns',
          data: {
            columns,
            before,
            placements,
            ...(fallback ? { fallback } : {}),
          },
        },
      })
    },
  })
}

export const columnCommandHandler = guard({ handler: ({ args }) => columnCommand({ args }) })

function hydraCommand({ args }: { args: string[] }): Output | Promise<Output> {
  if (args[0] === 'worker-notes') {
    return hydraCommand({
      args: [
        'memory',
        ...args.slice(1),
        '--key',
        'workers',
      ],
    })
  }

  if ([
    'create',
    'list',
    'homes',
    'show',
    'set',
  ].includes(args[0] ?? '')) {
    return hydraConfigCommand({ args })
  }

  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      task: { type: 'string' },
      action: { type: 'string' },
      kind: { type: 'string' },
      key: { type: 'string' },
      width: { type: 'string' },
      text: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      full: { type: 'boolean' },
      via: { type: 'string' },
      rule: { type: 'string' },
      harness: { type: 'string' },
      prompt: { type: 'string' },
      folder: { type: 'string' },
      home: { type: 'string' },
      'paseo-url': { type: 'string' },
    },
    positionals: 2,
  })

  if (positionals[0] === 'resize') {
    const width = integer({
      value: values.width,
      flag: '--width',
    })

    if (width === undefined) {
      throw new HydraError({
        message: 'pass --width <pixels>',
        code: 'VALIDATION_ERROR',
      })
    }

    const m = meta({ values })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'board.view',
        card: '$board',
      },
      decide: ({ state }) => decideView({
        state,
        patch: { hydraWidth: width },
        meta: m,
      }),
    })
  }

  if (positionals[0] === 'memory') {
    const action = positionals[1] ?? 'list'

    if (action === 'list') {
      const state = loadHydra({ hydraId }).state

      return memoryList({
        memory: state.hydraMemory ?? {},
        budget: HYDRA_MEMORY_BUDGET,
        empty: 'none: no Hydra memory yet',
      })
    }

    const {
      key,
      after,
    } = memoryChange({
      action,
      values,
      usage: 'use hydra memory list|set|forget',
    })

    if (after !== null && Object.hasOwn(
      OWNER_DOCUMENTS,
      key,
    )) {
      throw new HydraError({
        message: `${OWNER_DOCUMENTS[key as keyof typeof OWNER_DOCUMENTS]} are Pnyx-wide owner memory`,
        code: 'VALIDATION_ERROR',
        help: [`Run \`pnyx-axi owner memory set --key ${key} --text "<document>"\`, or save a note only this Hydra needs under another key`],
      })
    }

    const m = meta({ values })

    if (key === 'workers') {
      explained({ meta: m })
      checkWorkerNotes({
        text: after,
        reason: m.reason,
      })
    }

    const result = commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.memory',
        card: '$board',
      },
      decide: ({ state }) => {
        const before = state.hydraMemory?.[key]?.text ?? null
        checkBudget({
          memory: state.hydraMemory ?? {},
          key,
          after,
          budget: HYDRA_MEMORY_BUDGET,
          layer: 'Hydra',
        })

        return before === after ? { skipped: 'unchanged' } : hydraEvent({
          state,
          meta: m,
          cardId: '$board',
          change: {
            type: 'hydra.memory',
            data: {
              key,
              before,
              after,
            },
          },
        })
      },
    })

    if (key === 'workers' && result.event === 'none: unchanged') {
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const saved = readEvents({ hydraId }).findLast(event => event.type === 'hydra.memory'
            && event.data.key === 'workers')

          if (saved) {
            workerNotesNotice({
              writer,
              target: `Hydra ${hydraId}`,
              meta: saved,
            })
          }
        },
      })
    }

    return result
  }

  if (positionals[0] === 'start') {
    return startHydra({
      hydraId,
      via: values.via as string | undefined,
      rule: values.rule as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      home: values.home as string | undefined,
      url: values['paseo-url'] as string | undefined,
      meta: meta({ values }),
    })
  }

  if (positionals[0] === 'messages') {
    const state = loadHydra({ hydraId }).state
    const after = integer({
      value: values.after,
      flag: '--after',
    }) ?? 0
    const limit = Math.min(
      integer({
        value: values.limit,
        flag: '--limit',
      }) ?? HISTORY_LIMIT,
      HISTORY_MAX,
    )

    if (limit < 1) {
      throw new HydraError({
        message: '--limit must be positive',
        code: 'VALIDATION_ERROR',
      })
    }

    const events = readEvents({ hydraId }).filter((e): e is Extract<HydraEvent, { type: 'hydra.message' | 'task.reminder-due' }> => e.seq > after && (e.type === 'hydra.message' || e.type === 'task.reminder-due'))
    const page = events.slice(
      0,
      limit,
    )

    const through = page.at(-1)?.seq ?? after

    return {
      hydra: hydraConfig({
        state,
        id: hydraId,
      }).hydra.id,
      messages: page.length
        ? page.map(e => {
          const data = e.type === 'task.reminder-due' ? e.data.message : e.data

          return values.full ? e : {
            seq: e.seq,
            id: e.id,
            at: e.at,
            actor: e.type === 'task.reminder-due' ? HYDRA_ACTOR : e.actor,
            task: data.task ?? 'none',
            action: data.action,
            text: data.text,
            ...(data.details ? { details: data.details } : {}),
            ...('context' in data && data.context ? { context: data.context } : {}),
          }
        })
        : `none: no messages after seq ${after}`,
      through,
      ...(events.length > limit ? { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` for the next page`] } : { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` later for new messages`] }),
    }
  }

  if (positionals[0] === 'stop' || positionals[0] === 'usage') {
    const action = positionals[0]

    return readServer({ hydraId }).then(server => server ? askHost({
      hydraId,
      body: {
        action,
        actor: meta({ values }).actor,
      },
    }) : { [action === 'stop' ? 'stopped' : 'usage']: 'none: no Pnyx server runs this Hydra' })
  }

  if (positionals[0] !== 'send') {
    throw new HydraError({
      message: 'Use hydra send --text <message>, hydra send --task <id> [--action send|worker], hydra send --task <id> --kind progress --text <message>, hydra stop, hydra usage or hydra messages',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })

  const ref = values.task === undefined ? undefined : required({
    value: values.task as string,
    what: '--task',
  })

  if (!ref && values.action !== undefined) {
    throw new HydraError({
      message: '--action needs --task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (values.kind !== undefined && values.kind !== 'progress') {
    throw new HydraError({
      message: '--kind must be progress',
      code: 'VALIDATION_ERROR',
    })
  }

  const progress = values.kind === 'progress'

  const misused = !ref || !reportActor({ actor: m.actor }) || values.action !== undefined
    || values.text === undefined

  if (progress && misused) {
    throw new HydraError({
      message: '--kind progress is an agent\'s report: pass --task and --text, no --action, and --actor worker:<task> when PNYX_ACTOR is unset',
      code: 'VALIDATION_ERROR',
    })
  }

  const result = commit({
    hydraId,
    meta: m,
    intent: {
      type: 'hydra.message',
      card: ref ?? '$board',
    },
    decide: ({ state }) => {
      const task = ref ? findCard({
        state,
        ref,
      }) : undefined

      if (task && !liveTask({ card: task })) {
        throw new HydraError({
          message: 'choose a task, not an unassigned session',
          code: 'VALIDATION_ERROR',
        })
      }

      const action = String(values.action ?? 'send')

      if (action !== 'send' && action !== 'worker') {
        throw new HydraError({
          message: '--action must be send or worker',
          code: 'VALIDATION_ERROR',
        })
      }

      const entered = task
        ? String(values.text ?? `${action === 'worker' ? 'Create a worker for' : 'Work with me on'} task ${task.id}: ${task.title}. Read its task history and current record before continuing.`)
        : required({
          value: values.text as string | undefined,
          what: '--text',
        })
      const config = hydraConfig({
        state,
        id: hydraId,
      })
      const effective = effectiveDispatch({
        hydraId,
        state,
      })
      const provider = config.hydra.agent?.harness
        ?? effective.dispatch.rules.hydra?.candidates[0]?.harness
        ?? effective.dispatch.default[0]?.harness
        ?? state.cards[HYDRA_CARD]?.agent?.provider
      const text = resolveSkillReferences({
        text: entered,
        provider,
      })
      const context = mentionContext({
        state,
        text,
      })
      const decision = hydraEvent({
        state,
        meta: m,
        cardId: task?.id ?? '$board',
        change: {
          type: 'hydra.message',
          data: {
            ...(task ? { task: task.id } : {}),
            action,
            ...(progress ? { kind: 'progress' as const } : {}),
            text,
            ...(text !== entered ? { enteredText: entered } : {}),
            ...(m.details ? { details: m.details } : {}),
            ...(context ? { context } : {}),
            hydra: hydraConfig({
              state,
              id: hydraId,
            }).hydra.id,
          },
        },
      })

      if ('event' in decision) {
        decision.event.messageId = decision.event.id
      }

      return decision
    },
  })

  if (!ref && ownerActor({ actor: m.actor })) {
    nameHydra({
      hydraId,
      meta: m,
      text: String(values.text),
    })
  }

  const config = hydraConfig({
    state: loadHydra({ hydraId }).state,
    id: hydraId,
  })

  if (progress && result.event !== 'none: duplicate') {
    return {
      ...result,
      help: ['Saved on the card without waking Hydra; send questions, blockers and results through task ask or task status'],
    }
  }

  // Pnyx runs /upgrade itself, whichever agent the Hydra is.
  const pnyxRuns = config.hydra.kind !== 'firstmate' || upgradeCommand({ text: String(values.text ?? '') })

  if (!pnyxRuns || m.actor === HYDRA_ACTOR || result.event === 'none: duplicate' || !result.message) {
    return result
  }

  const message = loadHydra({ hydraId }).state.hydraMessages
    ?.find(message => message.id === result.message)
  const text = message ? hydraDelivery({ message }) : String(values.text ?? '')

  return readServer({ hydraId }).then(server => server ? askHost({
    hydraId,
    body: {
      action: 'hydra',
      id: String(result.message),
      text,
      actor: m.actor,
    },
  }).then(hosted => ({
    ...result,
    ...hosted,
    help: ['The Pnyx server runs Hydra; replies and startup errors appear in its chat'],
  })) : result)
}

export const hydraCommandHandler = guard({ handler: ({ args }) => hydraCommand({ args }) })

export const NOTES_SHOWN = 3
export const NOTE_CUT = 280
const NOTE_SECTIONS = {
  summary: 'summary',
  decision: 'decisions',
  context: 'context',
} as const

function cardNotes({
  hydraId,
  card,
  full,
}: {
  hydraId: string
  card: Card
  full: boolean
}): {
  notes: Output
  cut: boolean
} {
  const ids = new Set((card.notes ?? []).map(n => n.id))
  const events = ids.size ? readEvents({ hydraId }).filter((e): e is NotedEvent => e.type === 'card.noted' && ids.has(e.id)) : []
  let cut = false
  const notes: Output = {}

  for (const [
    kind,
    section,
  ] of Object.entries(NOTE_SECTIONS)) {
    const all = events
      .filter(e => e.data.kind === kind)
      .map(e => ({
        at: e.data.at ?? e.at,
        source: e.data.source,
        text: e.data.text,
      }))
    all.sort((
      a,
      b,
    ) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    const shown = full ? all : all.slice(
      0,
      NOTES_SHOWN,
    ).map(n => ({
      ...n,
      text: clip({
        text: n.text,
        limit: NOTE_CUT,
      }),
    }))

    if (shown.length < all.length || shown.some((
      n,
      i,
    ) => n.text !== all[i]!.text)) {
      cut = true
    }

    notes[section] = shown.length ? shown : 'none'

    if (shown.length < all.length) {
      notes[`${section}More`] = all.length - shown.length
    }
  }

  return {
    notes,
    cut,
  }
}

export const card = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        full: { type: 'boolean' },
      },
      positionals: 1,
    })
    const { state } = loadHydra({ hydraId })
    const found = findCard({
      state,
      ref: required({
        value: positionals[0],
        what: 'card id',
      }),
    })
    const {
      notes,
      cut,
    } = cardNotes({
      hydraId,
      card: found,
      full: Boolean(values.full),
    })
    const help = [`Run \`pnyx-axi history --card ${found.id}\` for its events`]

    if (cut || (!values.full && (found.brief ?? '').length > TEXT_CUT)) {
      help.unshift(`Run \`pnyx-axi card ${found.id} --full\` for the brief and every note in full`)
    }

    if (!found.notes?.length) {
      help.push(`Run \`pnyx-axi harvest --card ${found.id}\` to collect its summaries, decisions and context`)
    }

    const asking = found.attention.find(request => answerPrompt({
      card: found,
      request,
    }))

    if (asking) {
      help.unshift(`Run \`pnyx-axi reply ${found.id} --answer ${asking.key} --json <answer>\` to answer its ${asking.kind} (see \`pnyx-axi reply --help\`)`)
    }

    return {
      card: cardDetail({
        state,
        card: found,
        full: Boolean(values.full),
      }),
      notes,
      help,
    }
  },
})

// Collects the notes sources already recorded: the cards' transcripts from where
// the last read stopped, and each linked pull request's title and description.
// ponytail: reads every linked pull request on each run; skip merged ones already noted if hydras grow.
export const harvest = guard({
  handler: ({ args }) => {
    const {
      values,
      hydraId,
    } = parse({
      args,
      options: {
        ...COMMON,
        card: { type: 'string' },
      },
      positionals: 0,
    })
    const { state } = loadHydra({ hydraId })
    const cards = values.card ? [
      findCard({
        state,
        ref: values.card as string,
      }),
    ] : Object.values(state.cards)
    // Read before taking the writer lock: gh-axi can be slow and must not block other writers.
    const prs = cards.flatMap(c => c.links.filter(l => l.kind === 'github_pr').map(l => ({
      card: c.id,
      url: l.url,
      note: pullRequestNote({ url: l.url }),
    })))

    return withWriter({
      hydraId,
      fn: ({ writer }) => {
        const spool = drainSpool({ writer })
        const at = new Date().toISOString()
        let notes = harvestTranscripts({
          writer,
          cardIds: cards.map(c => c.id),
          at,
        })

        for (const pr of prs) {
          if (pr.note) {
            notes += appendNote({
              writer,
              cardId: pr.card,
              note: pr.note,
              at,
            })
          }
        }

        const unread = prs.filter(pr => !pr.note).map(pr => pr.url)
        const out: Output = {
          harvested: {
            cards: cards.length,
            notes: notes ? `${notes} new` : 'none: nothing new',
            pullRequests: prs.length - unread.length,
          },
        }

        if (unread.length) {
          out.unread = unread
        }

        if (spool.ingested || spool.rejected) {
          out.spool = spool
        }

        out.help = [
          ...(unread.length ? ['gh-axi could not read those pull requests; check `gh-axi pr view <number> --repo <owner/repo>`'] : []),
          values.card ? `Run \`pnyx-axi card ${cards[0]!.id}\` to see its notes` : "Run `pnyx-axi card <id>` to see a card's notes",
        ]

        return out
      },
    })
  },
})

export const move = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        before: { type: 'string' },
      },
      positionals: 2,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const target = column({
      value: required({
        value: positionals[1],
        what: 'column',
      }),
    })
    const before = values.before as string | undefined

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.moved',
        card: ref,
      },
      ...(m.actor !== 'web' ? { confirmation: { token: values.confirm as string | undefined } } : {}),
      decide: ({ state }) => decideMove({
        state,
        ref,
        column: hydraConfig({ state }).columns
          .find(c => c.id === target || c.role === target)?.id ?? target,
        before,
        meta: m,
      }),
    })
  },
})

export const link = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...WRITE,
      url: { type: 'string' },
      kind: { type: 'string' },
      number: { type: 'string' },
      title: { type: 'string' },
      state: { type: 'string' },
      remove: { type: 'boolean' },
    }
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 1,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const url = required({
      value: values.url as string | undefined,
      what: '--url',
    })
    const s = ({ name }: { name: string }) => values[name] as string | undefined
    const parsed = values.remove
      ? null
      : parseLink({
        input: {
          url,
          kind: s({ name: 'kind' }),
          number: s({ name: 'number' }),
          title: s({ name: 'title' }),
          state: s({ name: 'state' }),
          checkedAt: s({ name: 'state' }) && new Date().toISOString(),
        },
      })

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.linked',
        card: ref,
      },
      decide: ({ state }) => decideLink({
        state,
        ref,
        url,
        link: parsed,
        meta: m,
      }),
    })
  },
})

export const outcome = guard({
  handler: ({ args }) => {
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options: {
        ...WRITE,
        note: { type: 'string' },
        clear: { type: 'boolean' },
      },
      positionals: 2,
    })
    const m = meta({ values })
    const ref = required({
      value: positionals[0],
      what: 'card id',
    })
    const state = positionals[1]

    if (Boolean(values.clear) === (state !== undefined)) {
      throw new AxiError(
        'give either an outcome or --clear',
        'VALIDATION_ERROR',
        [`Outcomes: ${OUTCOME_STATES.join(', ')}`],
      )
    }

    if (state !== undefined && !(OUTCOME_STATES as readonly string[]).includes(state)) {
      throw new AxiError(
        `unknown outcome: ${state}`,
        'VALIDATION_ERROR',
        [`Use one of ${OUTCOME_STATES.join(', ')}`],
      )
    }

    const note = values.note as string | undefined
    const result = state === undefined
      ? null
      : {
        state: state as OutcomeState,
        ...(note ? { note } : {}),
      }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'card.outcome',
        card: ref,
      },
      decide: ({ state: s }) => decideOutcome({
        state: s,
        ref,
        outcome: result,
        meta: m,
      }),
    })
  },
})

export const setup = guard({
  handler: ({ args }) => {
    const options: Options = {
      ...WRITE,
      harness: { type: 'string' },
      remove: { type: 'boolean' },
      preview: { type: 'boolean' },
      'allow-custom-home': { type: 'boolean' },
      home: { type: 'string' },
      port: { type: 'string' },
    }
    const {
      values,
      positionals,
      hydraId,
    } = parse({
      args,
      options,
      positionals: 1,
    })

    if (positionals[0] === 'check') {
      return setupCheckOutput({ hydraId })
    }

    if ([
      'hooks',
      'service',
      'skills',
    ].includes(positionals[0] ?? '')) {
      requireSetupHome({ allowCustomHome: !!values['allow-custom-home'] })
    }

    if (positionals[0] === 'skills') {
      return setupSkills({
        remove: !!values.remove,
        preview: !!values.preview,
      })
    }

    if (positionals[0] === 'service') {
      if (values.home !== undefined || args.some(a => a === '--hydra' || a.startsWith('--hydra='))) {
        throw new AxiError(
          'setup service runs every Hydra; it takes no --hydra or --home',
          'VALIDATION_ERROR',
          ['Run `pnyx-axi setup hydra --home <firstmate home> --hydra <id>` to link a Firstmate home to its Hydra'],
        )
      }

      return setupService({
        port: integer({
          value: values.port,
          flag: '--port',
        }),
        remove: !!values.remove,
        preview: !!values.preview,
      })
    }

    if (positionals[0] === 'hydra') {
      return setupHydra({
        hydraId,
        home: required({
          value: values.home as string | undefined,
          what: '--home',
        }),
        meta: meta({ values }),
      })
    }

    if (positionals[0] !== 'hooks') {
      throw new AxiError(
        `unknown setup target: ${positionals[0] ?? '(none)'}`,
        'VALIDATION_ERROR',
        ['Run `pnyx-axi setup check`, `pnyx-axi setup skills`, `pnyx-axi setup hooks` or `pnyx-axi setup hydra --home <firstmate home>`'],
      )
    }

    const harness = values.harness as string | undefined

    if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
      throw new AxiError(
        `unknown harness: ${harness}`,
        'VALIDATION_ERROR',
        [`Use one of ${HARNESSES.join(', ')}`],
      )
    }

    const targets = harness ? [harness as Harness] : detectedHarnesses()

    if (targets.length === 0) {
      throw new AxiError(
        'no Claude Code or Codex config folder found',
        'NOT_FOUND',
        ['Run `pnyx-axi setup hooks --harness claude|codex`'],
      )
    }

    const remove = Boolean(values.remove)
    const preview = Boolean(values.preview)
    const hooks = targets.map(h => setupHooks({
      harness: h,
      opts: {
        remove,
        preview,
      },
    }))
    const out: Output = { hooks }

    if (preview) {
      out.preview = 'nothing written; rerun without --preview to apply'
    }

    const help: string[] = []

    if (!remove && !preview && targets.includes('codex')) {
      help.push('Codex asks you to review and trust new hooks: run `/hooks` in Codex')
    }

    help.push(remove ? 'Run `pnyx-axi setup hooks` to install them again' : 'New sessions appear on the Hydra; run `pnyx-axi` to see it')
    out.help = help

    return out
  },
})
