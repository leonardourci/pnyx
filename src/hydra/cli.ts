import { inform } from '#app/command-notices.ts'
import { removeHydraCommand } from './remove.ts'
import { requestedPolisAccess, widensPolisReads } from '#memory/access-changes.ts'
import { readMemoryContext } from '#memory/context.ts'
import { projectRows } from '#projects/read.ts'
import { checkMemoryApproval, readableProjects, polisAccess, hydraPolisConfig, memoryPermission, memoryAgent } from '#memory/poleis.ts'
import { MESSAGE_LOOKUP_OPTIONS, messageLookup } from './message-lookup-cli.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parse, WRITE, required, meta, commit, guard, type Options, type Output } from '#app/cli-support.ts'
import { hideDone } from '#tasks/retention.ts'
import { hydraIds, hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraConfig } from './config.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { HydraError } from '#store/errors.ts'
import { findSession } from '#workers/session-attachments.ts'
import { sessionRef } from '#workers/cli.ts'
import type { HydraIdentity, HydraConfig } from './model.ts'
import { HYDRA_ICONS, HYDRA_MARK, isHydraIcon, pickName } from './hydra-names.ts'
import { otherHydraNames } from './taken-names.ts'
import { hydraEvent } from './hydra.ts'
import { hydraMessages, hydraSend } from './send-cli.ts'
import { hydraResize } from '#preferences/cli.ts'
import { hydraMemory } from '#memory/cli.ts'
import { startHydra } from './start.ts'
import { HYDRA_CARD } from './identity.ts'
import { checkSettings, readSettings, saveSettings, settingsReceipt, shownSettings } from '#settings/store.ts'
import { SETTING_FLAGS, sharedSettingFlags, visibleSettings } from '#settings/cli.ts'
import { hydraActor } from '#app/request-context.ts'
import { raisesPermission } from '#workers/permission-level.ts'
import { requireStopAuthority } from '#app/stop-authority.ts'
import { workerIdentity } from '#workers/worker-identity.ts'
import { hydraHistory, hydraInscribe } from './history-cli.ts'
import { hydraQuestion } from './questions-cli.ts'

function visibleHydraConfig({
  config,
  hydraId,
}: {
  config: HydraConfig
  hydraId: string
}): Output {
  const shown: Output = {
    ...config,
    ...hydraPolisConfig({ state: { config } }),
  }

  if (memoryAgent()) {
    const access = polisAccess({ hydraId })
    shown.readPoleis = access.reads

    if (access.writablePolis === undefined) {
      delete shown.polis
    } else {
      shown.polis = access.writablePolis
    }
  }

  return shown
}

async function hydraConfigCommand({ args }: { args: string[] }): Promise<Output> {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      name: { type: 'string' },
      'read-poleis': { type: 'string' },
      'polis': { type: 'string' },
      propose: { type: 'boolean' },
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
    const hydras = hydraIds()

    if (!hydras.length) {
      return {
        hydras: 'none: no Hydras yet',
        help: ['Run `pnyx-axi hydra create <id>` to add one'],
      }
    }

    return {
      hydras: hydras.map(id => {
        let { state } = loadHydra({ hydraId: id })

        if (!state.config?.removing) {
          hideDone({ hydraId: id })
          state = loadHydra({ hydraId: id }).state
        }

        const config = hydraConfig({
          state,
          id,
        })

        const tasks = Object.values(state.cards).filter(c => liveTask({ card: c })).length

        return {
          id,
          name: config.name,
          hydra: config.hydra.id,
          tasks,
        }
      }),
      help: ['Run `pnyx-axi hydra show --hydra <id>` for its columns and Hydra'],
    }
  }

  const id = action !== 'create'
    ? hydraId
    : required({
      value: positionals[1],
      what: 'Hydra id',
    })
  hydraDir({ hydraId: id })

  if (loadHydra({ hydraId: id }).state.config?.removed) {
    throw new HydraError({
      message: `Hydra was removed: ${id}`,
      code: 'NOT_FOUND',
    })
  }

  if (action === 'show') {
    return readMemoryContext({
      read: async () => {
        const state = loadHydra({ hydraId: id }).state
        const hydra = structuredClone(hydraConfig({
          state,
          id,
        }))
        // Legacy config still carries values now owned by shared settings.
        delete hydra.doneAfterHours
        delete hydra.reviewMinutes
        delete hydra.helper
        const shared = readSettings().settings
        const projects = await readableProjects({
          state,
          hydraId: id,
        })

        return {
          hydra: visibleHydraConfig({
            config: hydra,
            hydraId: id,
          }),
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
      },
    })
  }

  if (action !== 'create' && action !== 'set') {
    throw new HydraError({
      message: 'Use hydra create <id>, list, show or set',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })
  const shared = sharedSettingFlags({
    values,
    hydraId: id,
  })
  const hydraFlags = Object.keys(values).some(flag => values[flag] !== undefined
    && !SETTING_FLAGS.includes(flag) && !(flag in WRITE))
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
      checkMemoryApproval()

      const previousAccess = hydraPolisConfig({ state })
      const nextAccess = requestedPolisAccess({
        current: previousAccess,
        reads: values['read-poleis'],
        polis: values.polis,
      })

      if (nextAccess) {
        memoryPermission({
          hydraId: id,
          name: 'hydra',
          args,
          propose: false,
          actor: m.actor,
          widening: widensPolisReads({
            before: previousAccess,
            after: nextAccess,
          }),
        })
      }

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

      const session = values.session ? findSession({
        state,
        ref: sessionRef({
          state,
          ref: String(values.session),
        }),
      }) : undefined

      if (session && session.taskId && session.taskId !== HYDRA_CARD) {
        throw new HydraError({
          message: 'detach the task worker before making it Hydra',
          code: 'CONFLICT',
        })
      }

      const hydraRequest = hydraActor({ actor: m.actor })

      if (hydraRequest && session && raisesPermission({
        harness: session.agent.provider === 'codex' ? 'codex' : 'claude',
        before: state.cards[HYDRA_CARD]?.settings?.mode,
        after: session.settings?.mode,
      })) {
        inform({
          reason: 'Hydra permission level increased through its session',
          clear: 'pnyx-axi hydra set --session <session>',
        })
      }

      const hydra: HydraIdentity = {
        name: 'Hydra',
        ...kept,
        id: identity,
        ...(session ? { session: session.id } : {}),
      }

      const command = values.command === undefined ? current.command : String(values.command).trim()
      const named = action === 'create' && values.name === undefined && !state.config
        ? pickName({ taken: otherHydraNames({ id }) })
        : undefined
      const data: HydraConfig = {
        ...current,
        id,
        name: String(values.name ?? named?.name ?? current.name),
        hydra,
      }

      if (nextAccess && values.polis !== undefined) {
        data.polis = nextAccess.polis
      }

      if (nextAccess && values['read-poleis'] !== undefined) {
        data.readPoleis = nextAccess.readPoleis
      }

      if (named) {
        data.icon = named.icon
      }

      if (values.icon !== undefined) {
        const icon = String(values.icon).trim()

        if (!isHydraIcon({ icon })) {
          throw new HydraError({
            message: `--icon must be ${HYDRA_MARK} or one of: ${HYDRA_ICONS.join(', ')}`,
            code: 'VALIDATION_ERROR',
          })
        }

        if (icon === HYDRA_MARK) {
          delete data.icon
        } else {
          data.icon = icon
        }
      }

      if (values.position !== undefined) {
        const position = Number(String(values.position).trim())

        if (!String(values.position).trim() || !Number.isFinite(position)) {
          throw new HydraError({
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

        inform({
          reason: `Hydra ${id} already exists; updated its requested settings`,
          clear: `Use pnyx-axi hydra set --hydra ${id} to change its settings`,
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

  if (committed && memoryAgent() && 'hydra' in committed) {
    committed.hydra = visibleHydraConfig({
      config: hydraConfig({
        state: loadHydra({ hydraId: id }).state,
        id,
      }),
      hydraId: id,
    })
  }

  if (!shared) {
    return committed!
  }

  const saved = saveSettings({
    beforeSave: onlySettings ? checkMemoryApproval : undefined,
    // A combined edit gets one chat notice from its Hydra receipt.
    hydraId: onlySettings ? id : undefined,
    patch: shared,
    meta: {
      ...m,
      ifRevision: undefined,
    },
  })
  const settings = settingsReceipt({ saved })

  if (memoryAgent()) {
    settings.settings = visibleSettings({
      settings: shownSettings({ settings: readSettings().settings }),
      hydraId: id,
    })
  }

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

export const HYDRA_OPTIONS: Options = {
  ...WRITE,
  ...MESSAGE_LOOKUP_OPTIONS,
  task: { type: 'string' },
  force: { type: 'boolean' },
  action: { type: 'string' },
  kind: { type: 'string' },
  key: { type: 'string' },
  width: { type: 'string' },
  text: { type: 'string' },
  after: { type: 'string' },
  since: { type: 'string' },
  budget: { type: 'string' },
  through: { type: 'string' },
  count: { type: 'boolean' },
  error: { type: 'string' },
  limit: { type: 'string' },
  full: { type: 'boolean' },
  inscribe: { type: 'boolean' },
  via: { type: 'string' },
  harness: { type: 'string' },
  prompt: { type: 'string' },
  folder: { type: 'string' },
}

function hydraCommand({ args }: { args: string[] }): Output | Promise<Output> {
  if (args[0] === 'remove') {
    return removeHydraCommand({ args })
  }

  if (args[0] === 'ask') {
    return hydraQuestion({ args: args.slice(1) })
  }

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
    options: HYDRA_OPTIONS,
    positionals: 2,
  })

  if (positionals[0] === 'send-now' || positionals[0] === 'cancel') {
    requireStopAuthority({ meta: meta({ values }) })

    return askHost({
      hydraId,
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
      hydraId,
      task: values.task as string | undefined,
    })
  }

  const readingHistory = positionals[0] === 'history' || (positionals[0] === 'messages' && values.inscribe)

  if (readingHistory) {
    return hydraHistory({
      values,
      hydraId,
    })
  }

  if (positionals[0] === 'inscribe') {
    return hydraInscribe({
      values,
      positionals,
      hydraId,
    })
  }

  if (positionals[0] === 'resize') {
    return hydraResize({
      values,
      hydraId,
    })
  }

  if (positionals[0] === 'memory') {
    return hydraMemory({
      values,
      positionals,
      hydraId,
    })
  }

  if (positionals[0] === 'start') {
    return startHydra({
      hydraId,
      via: values.via as string | undefined,
      harness: values.harness as string | undefined,
      prompt: values.prompt as string | undefined,
      folder: values.folder as string | undefined,
      meta: meta({ values }),
    })
  }

  if (positionals[0] === 'messages') {
    return hydraMessages({
      values,
      hydraId,
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
        reason: 'Worker refreshed plan limits shared by every Hydra',
        clear: 'pnyx-axi hydra usage',
      })
    }

    return readServer({ hydraId }).then(server => server ? askHost({
      hydraId,
      body: {
        action,
        card: values.task,
        force: values.force,
        actor: meta({ values }).actor,
      },
    }) : { [action === 'stop' ? 'stopped' : 'usage']: 'none: no Pnyx server runs this Hydra' })
  }

  if (positionals[0] !== 'send') {
    throw new HydraError({
      message: 'Use hydra send --text <message>, hydra send --task <id> [--action send|worker], hydra send --task <id> --kind progress --text <message>, hydra stop, hydra usage, hydra messages or hydra message',
      code: 'VALIDATION_ERROR',
    })
  }

  return hydraSend({
    values,
    hydraId,
  })
}

export const hydraCommandHandler = guard({ handler: ({ args }) => hydraCommand({ args }) })
