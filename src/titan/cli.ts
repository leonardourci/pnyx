import { POLIS_NAME, ownerPolis } from '#memory/owner-polis.ts'
import { projectsFor } from '#projects/read.ts'
import { inform } from '#app/command-notices.ts'
import { removeTitanCommand } from './remove.ts'
import { projectRows } from '#projects/read.ts'
import { MESSAGE_LOOKUP_OPTIONS, messageLookup } from './message-lookup-cli.ts'
import { isDeepStrictEqual } from 'node:util'
import { parse, WRITE, required, meta, commit, guard, type Options, type Output } from '#app/cli-support.ts'
import { hideDone } from '#tasks/retention.ts'
import { titanIds, titanDir } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { liveTask } from '#tasks/select.ts'
import { titanConfig } from './config.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { TitanError } from '#store/errors.ts'
import { findSession } from '#workers/session-attachments.ts'
import { decideSession } from '#workers/sessions.ts'
import { applyDecision } from '#app/decision.ts'
import { sessionRef } from '#workers/cli.ts'
import type { TitanIdentity, TitanConfig } from './model.ts'
import { TITAN_ICONS, TITAN_MARK, isTitanIcon, pickName } from './titan-names.ts'
import { otherTitanNames } from './taken-names.ts'
import { titanEvent } from './titan.ts'
import { titanMessages, titanSend } from './send-cli.ts'
import { titanResize } from '#preferences/cli.ts'
import { titanMemory } from '#memory/cli.ts'
import { startTitan } from './start.ts'
import { TITAN_CARD } from './identity.ts'
import { checkSettings, readSettings, saveSettings, settingsReceipt } from '#settings/store.ts'
import { SETTING_FLAGS, sharedSettingFlags } from '#settings/cli.ts'
import { titanActor } from '#app/request-context.ts'
import { raisesPermission } from '#workers/permission-level.ts'
import { requireStopAuthority } from '#app/stop-authority.ts'
import { workerIdentity } from '#workers/worker-identity.ts'
import { titanInscribe } from './inscribe-cli.ts'
import { titanQuestion } from './questions-cli.ts'

async function titanConfigCommand({ args }: { args: string[] }): Promise<Output> {
  const {
    values,
    positionals,
    titanId,
  } = parse({
    args,
    options: {
      ...WRITE,
      name: { type: 'string' },
      'polis': { type: 'string' },
      icon: { type: 'string' },
      position: { type: 'string' },
      identity: { type: 'string' },
      session: { type: 'string' },
      command: { type: 'string' },
      'command-folder': { type: 'string' },
      'done-after-hours': { type: 'string' },
      'review-minutes': { type: 'string' },
      helper: { type: 'string' },
      'helper-model': { type: 'string' },
      'helper-account': { type: 'string' },
      'helper-effort': { type: 'string' },
      'helper-fast': { type: 'string' },
    },
    positionals: 2,
  })
  const action = positionals[0]

  if (action === 'list') {
    const titans = titanIds()

    if (!titans.length) {
      return {
        titans: 'none: no Titans yet',
        help: ['Add a Titan from the header in the UI'],
      }
    }

    return {
      titans: await Promise.all(titans.map(async id => {
        let { state } = loadTitan({ titanId: id })

        if (!state.config?.removing) {
          await hideDone({ titanId: id })
          state = loadTitan({ titanId: id }).state
        }

        const config = titanConfig({
          state,
          id,
        })

        const tasks = Object.values(state.cards).filter(c => liveTask({ card: c })).length

        return {
          id,
          name: config.name,
          titan: config.titan.id,
          tasks,
        }
      })),
      help: ['Use othrys titan --titan <id> to inspect the Titan'],
    }
  }

  const id = action !== 'create'
    ? titanId
    : required({
      value: positionals[1],
      what: 'Titan id',
    })
  titanDir({ titanId: id })

  if (loadTitan({ titanId: id }).state.config?.removed) {
    throw new TitanError({
      message: `Titan was removed: ${id}`,
      code: 'NOT_FOUND',
    })
  }

  if (action === 'show') {
    const state = loadTitan({ titanId: id }).state
    const titan = structuredClone(titanConfig({
      state,
      id,
    }))
    delete titan.doneAfterHours
    delete titan.reviewMinutes
    delete titan.helper
    const shared = readSettings().settings
    const projects = projectsFor({ state })

    return {
      titan: {
        ...titan,
        polis: ownerPolis({ state }),
      },
      settings: {
        doneAfterHours: shared.doneAfterHours,
        reviewMinutes: shared.reviewMinutes,
        helper: shared.helper,
      },
      projects: projectRows({
        state,
        projects,
      }),
      revision: state.configRevision ?? 0,
    }
  }

  if (action !== 'create' && action !== 'set') {
    throw new TitanError({
      message: 'Use titan create <id>, list, show or set',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })
  const shared = sharedSettingFlags({
    values,
    titanId: id,
  })
  const titanFlags = Object.keys(values).some(flag => values[flag] !== undefined
    && !SETTING_FLAGS.includes(flag) && !(flag in WRITE))
  const onlySettings = shared !== undefined && action === 'set' && !titanFlags

  if (shared) {
    checkSettings({ patch: shared })
  }

  const committed = onlySettings ? undefined : await commit({
    titanId: id,
    create: action === 'create',
    meta: m,
    intent: {
      type: 'titan.configured',
      card: '$all',
    },
    prepare: ({ writer }) => {
      if (!values.session) {
        return
      }

      const session = findSession({
        state: writer.state,
        ref: sessionRef({
          state: writer.state,
          ref: String(values.session),
        }),
      })

      if (session.taskId && session.taskId !== TITAN_CARD) {
        inform({
          task: session.taskId,
          reason: 'Worker detached from its task before becoming Titan',
          clear: `Review the worker assigned to task ${session.taskId} in the UI.`,
        })
        applyDecision({
          writer,
          decision: decideSession({
            state: writer.state,
            ref: session.id,
            task: null,
            meta: {
              ...m,
              id: undefined,
              ifRevision: undefined,
            },
          }),
        })
      }
    },
    decide: ({ state }) => {
      if (values.polis !== undefined && !POLIS_NAME.test(String(values.polis))) {
        throw new TitanError({
          message: 'Invalid owner memory polis name',
          code: 'VALIDATION_ERROR',
        })
      }

      const current = titanConfig({
        state,
        id,
      })

      const identity = String(values.identity ?? current.titan.id)
      required({
        value: identity.trim(),
        what: '--identity',
      })
      const kept = identity === current.titan.id ? current.titan : undefined

      const session = values.session ? findSession({
        state,
        ref: sessionRef({
          state,
          ref: String(values.session),
        }),
      }) : undefined

      const titanRequest = titanActor({ actor: m.actor })

      if (titanRequest && session && raisesPermission({
        harness: session.agent.provider === 'codex' ? 'codex' : 'claude',
        before: state.cards[TITAN_CARD]?.settings?.mode,
        after: session.settings?.mode,
      })) {
        inform({
          reason: 'Titan permission level increased through its session',
          clear: 'Review the Titan session in the UI.',
        })
      }

      const titan: TitanIdentity = {
        name: 'Titan',
        ...kept,
        id: identity,
        ...(session ? { session: session.id } : {}),
      }

      const command = values.command === undefined ? current.command : String(values.command).trim()
      const named = action === 'create' && values.name === undefined && !state.config
        ? pickName({ taken: otherTitanNames({ id }) })
        : undefined
      const data: TitanConfig = {
        ...current,
        id,
        name: String(values.name ?? named?.name ?? current.name),
        titan,
      }

      if (values.polis !== undefined) {
        data.polis = String(values.polis)
      }

      if (named) {
        data.icon = named.icon
      }

      if (values.icon !== undefined) {
        const icon = String(values.icon).trim()

        if (!isTitanIcon({ icon })) {
          throw new TitanError({
            message: `--icon must be ${TITAN_MARK} or one of: ${TITAN_ICONS.join(', ')}`,
            code: 'VALIDATION_ERROR',
          })
        }

        if (icon === TITAN_MARK) {
          delete data.icon
        } else {
          data.icon = icon
        }
      }

      if (values.position !== undefined) {
        const position = Number(String(values.position).trim())

        if (!String(values.position).trim() || !Number.isFinite(position)) {
          throw new TitanError({
            message: '--position must be a number',
            code: 'VALIDATION_ERROR',
          })
        }

        data.position = position
      }

      delete data.command

      if (command) {
        data.command = command
      }

      const owns = values['command-folder']

      if (owns !== undefined && owns !== 'own' && owns !== 'copy') {
        throw new TitanError({
          message: '--command-folder must be own or copy',
          code: 'VALIDATION_ERROR',
        })
      }

      if (owns === 'own') {
        data.commandOwnsFolder = true
      } else if (owns === 'copy') {
        delete data.commandOwnsFolder
      }

      // Creating a Titan that already exists as asked is a no-op; other settings need titan set.
      if (action === 'create' && state.configured) {
        if (isDeepStrictEqual(
          data,
          titanConfig({
            state,
            id,
          }),
        )) {
          return { skipped: 'unchanged' }
        }

        inform({
          reason: `Titan ${id} already exists; updated its requested settings`,
          clear: `Review the settings of Titan ${id} in the UI.`,
        })
      }

      return titanEvent({
        state,
        meta: m,
        cardId: '$all',
        change: {
          type: 'titan.configured',
          data,
        },
      })
    },
  })

  if (!shared) {
    return committed!
  }

  const saved = await saveSettings({
    // A combined edit gets one chat notice from its Titan receipt.
    titanId: onlySettings ? id : undefined,
    patch: shared,
    meta: {
      ...m,
      ifRevision: undefined,
    },
  })
  const settings = settingsReceipt({ saved })

  if (committed) {
    return {
      ...committed,
      settings,
    }
  }

  return {
    ...settings,
    help: ['These settings apply to every Titan; see `othrys settings show`'],
  }
}

export const TITAN_OPTIONS: Options = {
  ...WRITE,
  ...MESSAGE_LOOKUP_OPTIONS,
  task: { type: 'string' },
  force: { type: 'boolean' },
  action: { type: 'string' },
  key: { type: 'string' },
  width: { type: 'string' },
  text: { type: 'string' },
  after: { type: 'string' },
  budget: { type: 'string' },
  through: { type: 'string' },
  error: { type: 'string' },
  limit: { type: 'string' },
  full: { type: 'boolean' },
  inscribe: { type: 'boolean' },
  via: { type: 'string' },
  harness: { type: 'string' },
  prompt: { type: 'string' },
  folder: { type: 'string' },
}

async function titanCommand({ args }: { args: string[] }): Promise<Output> {
  if (args[0] === 'remove') {
    return removeTitanCommand({ args })
  }

  if (args[0] === 'ask') {
    return await titanQuestion({ args: args.slice(1) })
  }

  if (args[0] === 'worker-notes') {
    return await titanCommand({
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
    'show',
    'set',
  ].includes(args[0] ?? '')) {
    return titanConfigCommand({ args })
  }

  const {
    values,
    positionals,
    titanId,
  } = parse({
    args,
    options: TITAN_OPTIONS,
    positionals: 2,
  })

  if (positionals[0] === 'cancel') {
    requireStopAuthority({ meta: meta({ values }) })

    return askHost({
      titanId,
      body: {
        action: positionals[0],
        message: required({
          value: positionals[1],
          what: 'message id',
        }),
        actor: meta({ values }).actor,
      },
    })
  }

  if (positionals[0] === 'message') {
    return messageLookup({
      values,
      titanId,
      task: values.task as string | undefined,
    })
  }

  if (positionals[0] === 'inscribe') {
    return await titanInscribe({
      values,
      positionals,
      titanId,
    })
  }

  if (positionals[0] === 'resize') {
    return await titanResize({
      values,
      titanId,
    })
  }

  if (positionals[0] === 'memory') {
    return await titanMemory({
      values,
      positionals,
      titanId,
    })
  }

  if (positionals[0] === 'start') {
    return startTitan({
      titanId,
      via: values.via as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      meta: meta({ values }),
    })
  }

  if (positionals[0] === 'messages') {
    return titanMessages({
      values,
      titanId,
    })
  }

  if (positionals[0] === 'stop' || positionals[0] === 'usage') {
    const action = positionals[0] === 'usage' && positionals[1] === 'refresh'
      ? 'usage-refresh' : positionals[0]

    if (action === 'stop') {
      requireStopAuthority({ meta: meta({ values }) })
    }

    if (action === 'usage-refresh' && workerIdentity({ actor: meta({ values }).actor })) {
      inform({
        reason: 'Worker refreshed plan limits shared by every Titan',
        clear: 'othrys titan usage',
      })
    }

    return readServer({ titanId }).then(server => server ? askHost({
      titanId,
      body: {
        action,
        card: values.task,
        force: values.force,
        actor: meta({ values }).actor,
      },
    }) : { [action === 'stop' ? 'stopped' : 'usage']: 'none: no Othrys server runs this Titan' })
  }

  if (positionals[0] !== 'send') {
    throw new TitanError({
      message: 'Use titan send --text <message>, titan send --task <id> [--action send|worker], titan stop, titan usage, titan messages or titan message',
      code: 'VALIDATION_ERROR',
    })
  }

  return titanSend({
    values,
    titanId,
  })
}

export const titanCommandHandler = guard({ handler: titanCommand })
