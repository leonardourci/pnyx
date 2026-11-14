import { MESSAGE_LOOKUP_OPTIONS, messageLookup } from './message-lookup-cli.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { basename } from 'node:path'
import { parse, WRITE, required, meta, commit, guard, type Output } from '#app/cli-support.ts'
import { hideDone } from '#tasks/retention.ts'
import { hydraIds, hydraDir } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraConfig } from './config.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { projectRows } from '#projects/read.ts'
import { firstmateHomes } from '#integrations/cli.ts'
import { HydraError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
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
import { checkSettings, readSettings, saveSettings, settingsReceipt } from '#settings/store.ts'
import { SETTING_FLAGS, sharedSettingFlags } from '#settings/cli.ts'
import { hydraActor } from '#app/request-context.ts'
import { raisesPermission } from '#workers/permission-level.ts'
import { hydraHistory, hydraInscribe } from './history-cli.ts'
import { hydraQuestion } from './questions-cli.ts'

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
      icon: { type: 'string' },
      position: { type: 'string' },
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
      'helper-account': { type: 'string' },
      'helper-effort': { type: 'string' },
      'helper-fast': { type: 'string' },
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

      const hydraRequest = hydraActor({ actor: m.actor })

      if (hydraRequest && session && raisesPermission({
        harness: session.agent.provider === 'codex' ? 'codex' : 'claude',
        before: state.cards[HYDRA_CARD]?.settings?.mode,
        after: session.settings?.mode,
      })) {
        throw new HydraError({
          message: 'Only the owner can raise Hydra’s permission level by changing its session',
          code: 'OWNER_ONLY',
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
      // A new Hydra without a name takes a Greek one and its icon; a Firstmate Hydra keeps its home's name.
      const named = action === 'create' && values.name === undefined && !home && !state.config
        ? pickName({ taken: otherHydraNames({ id }) })
        : undefined
      const data: HydraConfig = {
        ...current,
        id,
        name: String(values.name ?? named?.name ?? current.name),
        hydra,
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
      // A combined edit gets one chat notice from its Hydra receipt.
      hydraId: onlySettings ? id : undefined,
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
      rule: { type: 'string' },
      harness: { type: 'string' },
      prompt: { type: 'string' },
      folder: { type: 'string' },
      home: { type: 'string' },
      'paseo-url': { type: 'string' },
    },
    positionals: 2,
  })

  if (positionals[0] === 'send-now') {
    return askHost({
      hydraId,
      body: {
        action: 'send-now',
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
    return hydraMessages({
      values,
      hydraId,
    })
  }

  if (positionals[0] === 'stop' || positionals[0] === 'usage') {
    const action = positionals[0] === 'usage' && positionals[1] === 'refresh'
      ? 'usage-refresh' : positionals[0]

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
