import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { basename } from 'node:path'
import { HOME_LIMIT, parse, WRITE, required, meta, commit, integer, explained, HISTORY_LIMIT, HISTORY_MAX, guard, type Output } from '#app/cli-support.ts'
import { hideDone } from '#tasks/retention.ts'
import { DEFAULT_HYDRA, hydraIds, hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { liveTask, rankOf } from '#tasks/select.ts'
import { hydraConfig } from './config.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { projectRows } from '#projects/read.ts'
import { spoolFiles } from '#store/storage.ts'
import type { Card } from '#tasks/model.ts'
import { cardRow } from '#tasks/cli.ts'
import { firstmateHomes } from '#integrations/cli.ts'
import { HydraError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { findSession } from '#workers/session-attachments.ts'
import { sessionRef } from '#workers/cli.ts'
import type { HydraIdentity, HydraConfig } from './model.ts'
import { hydraEvent, reportActor, hydraDelivery } from './hydra.ts'
import { FILE_BLOCK } from './attachments.ts'
import { REFERENCE, referenceLabel, mentionContext } from './mentions.ts'
import { IMAGE, imageNames } from './images.ts'
import type { Meta } from '#app/command-meta.ts'
import { decideView } from '#preferences/decisions.ts'
import { memoryList, memoryChange } from '#memory/cli.ts'
import { HYDRA_MEMORY_BUDGET, OWNER_DOCUMENTS, checkBudget } from '#memory/budgets.ts'
import { checkWorkerNotes, workerNotesNotice } from '#memory/workers.ts'
import { withWriter } from '#app/writer.ts'
import { readEvents } from '#app/event-log.ts'
import { startHydra } from '#workers/start.ts'
import type { HydraEvent } from '#app/model.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import { findCard } from '#tasks/push-rules.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { HYDRA_CARD } from './identity.ts'
import { resolveSkillReferences } from './skill-invocation.ts'
import { upgradeCommand } from '#upgrade/model.ts'
import { checkSettings, readSettings, saveSettings, settingsReceipt } from '#settings/store.ts'
import type { Settings } from '#settings/model.ts'
import type { AgentConfig } from '#workers/model.ts'
import { HELPER_MODELS } from '#routine-helper/route.ts'

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

// The hydra set flags that write shared settings; any other flag changes this Hydra, so the Hydra event is committed too.
const SETTING_FLAGS = [
  'done-after-hours',
  'review-minutes',
  'helper',
  'helper-model',
  'helper-effort',
]

function sharedSettingFlags({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Partial<Settings> | undefined {
  const patch: Partial<Settings> = {}
  const done = values['done-after-hours']

  if (done !== undefined) {
    const raw = String(done).trim()
    patch.doneAfterHours = raw === 'off' ? 'off' : Number(raw || Number.NaN)
  }

  if (values['review-minutes'] !== undefined) {
    const raw = String(values['review-minutes']).trim()

    if (!raw) {
      throw new HydraError({
        message: '--review-minutes takes a number of minutes (0 turns reviews off)',
        code: 'VALIDATION_ERROR',
      })
    }

    patch.reviewMinutes = Number(raw)
  }

  if (values.helper !== undefined || values['helper-model'] !== undefined || values['helper-effort'] !== undefined) {
    const current = readSettings().settings.helper
    const agent = typeof current === 'object' ? current : undefined
    const harness = values.helper ?? agent?.harness ?? hydraConfig({ state: loadHydra({ hydraId }).state }).hydra.agent?.harness ?? 'claude'

    if (harness === 'off' || harness === 'auto') {
      patch.helper = harness
    } else if (harness === 'claude' || harness === 'codex') {
      const previous = agent?.harness === harness ? agent : undefined
      const effort = values['helper-effort'] ?? previous?.effort
      const helper: AgentConfig = {
        harness,
        model: String(values['helper-model'] ?? previous?.model ?? HELPER_MODELS[harness]),
      }

      if (effort !== undefined) {
        helper.effort = String(effort)
      }

      patch.helper = helper
    } else {
      throw new HydraError({
        message: '--helper takes auto, off, claude or codex',
        code: 'VALIDATION_ERROR',
      })
    }
  }

  return Object.keys(patch).length ? patch : undefined
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

    const hydra = structuredClone(hydraConfig({
      state,
      id,
    }))
    // These three live in the shared settings; a Hydra's own config copy is never read.
    delete hydra.doneAfterHours
    delete hydra.reviewMinutes
    delete hydra.helper
    const shared = readSettings().settings

    return {
      hydra,
      settings: {
        doneAfterHours: shared.doneAfterHours,
        reviewMinutes: shared.reviewMinutes,
        helper: shared.helper,
      },
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
  const shared = sharedSettingFlags({
    values,
    hydraId: id,
  })
  // --base only shapes hydra homes, so on set it changes nothing in the Hydra.
  const hydraFlags = Object.keys(values).some(flag => values[flag] !== undefined
    && !SETTING_FLAGS.includes(flag) && !(flag in WRITE) && flag !== 'base')
  const onlySettings = shared !== undefined && action === 'set' && !hydraFlags

  if (shared) {
    checkSettings({ patch: shared })
  }

  const committed = onlySettings ? undefined : commit({
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

  if (!shared) {
    return committed!
  }

  const settings = settingsReceipt({
    saved: saveSettings({
      patch: shared,
      meta: {
        ...m,
        ifRevision: undefined,
      },
    }),
  })

  if (committed) {
    return {
      ...committed,
      settings,
    }
  }

  return {
    ...settings,
    help: ['These settings apply to every Hydra; see `pnyx-axi settings show`'],
  }
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

  // Read before the Hydra writer, so the shared registry lock is never taken inside it.
  const effective = effectiveDispatch()
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
