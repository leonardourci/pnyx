import type { Host, UsageInputs } from './host-types.ts'
import { isHelper, taskLease } from '#routine-helper/leases.ts'
import { HydraError } from '#store/errors.ts'
import { loadHydra } from './store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { helperGrant, type HelperAction } from '#routine-helper/route.ts'
import { isAbsolute } from 'node:path'
import { field } from '#workers/http.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { validateChoice, chosenSettings, readQuota } from '#workers/dispatch.ts'
import { knownHarness, providerIdOf } from '#workers/providers.ts'
import { hydraFastReaches, modelIds } from '#workers/provider.ts'
import { SETTINGS } from '#workers/host.ts'
import { requireOwnerToRaise, workerMode } from '#workers/permission-level.ts'

// The host names the helper's reply action 'send'.
const HELPER_ACTIONS: Record<string, HelperAction> = {
  send: 'reply',
  continue: 'continue',
  permission: 'permission',
}

export async function hostRequestUnlocked({
  host,
  body: raw,
  usage = {},
}: {
  host: Host
  body: unknown
  usage?: UsageInputs
}): Promise<Record<string, unknown>> {
  const body = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const actor = field({
    body,
    name: 'actor',
    optional: true,
  }) ?? 'cli'

  switch (body.action) {
    case 'compact':
      return host.compact({
        card: field({
          body,
          name: 'card',
        })!,
        sendNow: field({
          body,
          name: 'sendNow',
          optional: true,
        }),
      })
    case 'hydra':
      return host.hydra({
        text: field({
          body,
          name: 'text',
        })!,
        id: field({
          body,
          name: 'id',
        })!,
        actor,
      })

    case 'stop':
      return host.stop()

    case 'upgrade':
      return host.upgrade({
        id: field({
          body,
          name: 'id',
        })!,
        now: body.now === true,
      })

    case 'tool-catalog':
      return {
        tools: await host.toolCatalog({
          task: field({
            body,
            name: 'task',
          })!,
          harness: field({
            body,
            name: 'harness',
            optional: true,
          }),
          account: field({
            body,
            name: 'account',
            optional: true,
          }),
        }),
      }

    case 'tools-changed':
      host.toolsChanged({
        task: field({
          body,
          name: 'task',
        })!,
      })

      return { applied: 'at the next safe turn boundary' }

    case 'release':
      return host.release({
        permanent: body.permanent === true,
        task: field({
          body,
          name: 'task',
        })!,
      })

    case 'usage':
      return host.usage({
        card: field({
          body,
          name: 'card',
          optional: true,
        }),
        ...usage,
      })

    case 'usage-refresh':
      return host.refreshUsage({
        card: field({
          body,
          name: 'card',
          optional: true,
        }),
        force: body.force === true,
      })

    case 'start': {
      const folder = field({
        body,
        name: 'folder',
        optional: true,
      })

      if (folder !== undefined && !isAbsolute(folder)) {
        throw new HydraError({
          message: 'folder must be an absolute path',
          code: 'VALIDATION_ERROR',
        })
      }

      const task = field({
        body,
        name: 'task',
      })!
      const current = loadHydra({ hydraId: host.hydraId }).state
      const project = findCard({
        state: current,
        ref: task,
      }).project
      const dispatch = validateChoice({
        value: body.dispatch,
        config: effectiveDispatch(),
        project,
      })

      requireOwnerToRaise({
        state: current,
        actor,
        harness: dispatch.provider,
        before: dispatch.candidate.mode,
        after: dispatch.override?.mode,
      })

      if (dispatch.ownerOverride || dispatch.candidate.account) {
        const settings = chosenSettings({ choice: dispatch })

        if (settings.model) {
          const models = modelIds({
            models: await host.models({
              harness: dispatch.provider,
              account: dispatch.account,
            }),
          })
          const model = dispatch.provider === 'claude' ? settings.model.replace(
            /\[1m\]$/,
            '',
          ) : settings.model

          if (!models.includes(model)) {
            throw new HydraError({
              message: `${dispatch.provider}/${settings.model}: not offered`,
              code: 'VALIDATION_ERROR',
            })
          }
        }

        if ((await readQuota({
          account: {
            provider: dispatch.provider,
            folder: dispatch.folder,
          },
        })).auth === 'signed-out') {
          throw new HydraError({
            message: `account ${dispatch.account} is signed out`,
            code: 'ACCOUNT_SIGNED_OUT',
          })
        }
      }

      // A setting changed after the start would reach only the next turn.
      const settings: Record<string, string> = {
        ...chosenSettings({ choice: dispatch }),
        provider: providerIdOf({ harness: dispatch.provider }),
      }
      const mode = workerMode({
        state: current,
        harness: dispatch.provider,
        mode: settings.mode,
      })

      if (mode !== undefined) {
        settings.mode = mode
      }

      // An explicit task start --fast wins; otherwise Fast in Hydra's composer reaches every worker, even a candidate saved with Fast off.
      const ownerFast = dispatch.override?.fast !== undefined
      const hydraFast = !ownerFast && await hydraFastReaches({
        hydraFast: current.config?.hydra.agent?.fast,
        models: () => host.models({
          harness: dispatch.provider,
          account: dispatch.account,
        }),
        model: settings.model,
      })

      if (hydraFast) {
        settings.fast = 'true'
      }

      return host.start({
        dispatch,
        task,
        prompt: field({
          body,
          name: 'prompt',
        })!,
        folder,
        settings,
        replacement: field({
          body,
          name: 'replacement',
          optional: true,
        }),
        id: field({
          body,
          name: 'id',
        })!,
        actor,
        reason: field({
          body,
          name: 'reason',
          optional: true,
        }),
      })
    }

    case 'models': {
      const harness = knownHarness({
        name: field({
          body,
          name: 'harness',
        }),
      })

      if (!harness) {
        throw new HydraError({
          message: 'models expects claude or codex',
          code: 'VALIDATION_ERROR',
        })
      }

      return {
        models: await host.models({
          harness,
          account: field({
            body,
            name: 'account',
            optional: true,
          }),
        }),
      }
    }

    case 'permission': {
      const choice = field({
        body,
        name: 'choice',
      })

      if (choice !== 'allow' && choice !== 'deny') {
        throw new HydraError({
          message: 'choice must be allow or deny',
          code: 'VALIDATION_ERROR',
        })
      }

      return host.permission({
        task: field({
          body,
          name: 'task',
        })!,
        request: field({
          body,
          name: 'request',
        })!,
        choice,
        ...(body.answer !== undefined ? { answer: body.answer } : {}),
        actor,
        reason: field({
          body,
          name: 'reason',
          optional: true,
        }),
        details: field({
          body,
          name: 'details',
          optional: true,
        }),
      })
    }
    case 'continue':
      return host.continue({
        task: field({
          body,
          name: 'task',
        })!,
        id: field({
          body,
          name: 'id',
        })!,
        actor,
        reason: field({
          body,
          name: 'reason',
          optional: true,
        }),
        check: body.check === true,
      })

    case 'send': {
      const steering = field({
        body,
        name: 'steering',
        optional: true,
      })
      let text = ''

      if (!steering) {
        text = field({
          body,
          name: 'text',
        })!
      }

      const result = host.send({
        inputId: field({
          body,
          name: 'inputId',
          optional: true,
        }),
        steering,
        attempt: field({
          body,
          name: 'attempt',
          optional: true,
        }),
        direct: body.direct === true,
        card: field({
          body,
          name: 'card',
        })!,
        text,
        actor,
      })

      return {
        sent: !result?.deferred,
        deferred: result?.deferred ?? false,
        queued: result?.queued ?? false,
        pending: result?.pending ?? false,
      }
    }
    case 'set': {
      const setting = field({
        body,
        name: 'setting',
      })!
      const value = field({
        body,
        name: 'value',
      })!

      if (!SETTINGS.includes(setting)) {
        throw new HydraError({
          message: `${setting} cannot be ${value}`,
          code: 'VALIDATION_ERROR',
          help: [`Settings: ${SETTINGS.join(', ')}`],
        })
      }

      await host.set({
        card: field({
          body,
          name: 'card',
        })!,
        setting,
        value,
        actor,
      })

      return { set: true }
    }

    default:
      throw new HydraError({
        message: 'action must be hydra, start, models, continue, send, set or permission',
        code: 'VALIDATION_ERROR',
      })
  }
}

export async function hostRequest({
  host,
  body,
  usage = {},
}: {
  host: Host
  body: unknown
  usage?: UsageInputs
}): Promise<Record<string, unknown>> {
  const request = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const actor = typeof request.actor === 'string' ? request.actor : 'cli'
  const helper = isHelper({ actor })
  const action = request.action

  if (helper && !Object.hasOwn(
    HELPER_ACTIONS,
    String(action),
  )) {
    throw new HydraError({
      message: 'This action belongs to the main Hydra',
      code: 'MAIN_ONLY',
    })
  }

  const ref = request.task ?? request.card
  let release = () => {}

  // A message from main or the owner queues for the agent; it never takes or waits on the helper's lease.
  const message = action === 'send' && !helper

  if (typeof ref === 'string' && !message && [
    'start',
    'continue',
    'send',
    'set',
    'permission',
  ].includes(String(action))) {
    const state = loadHydra({ hydraId: host.hydraId }).state
    const card = findCard({
      state,
      ref,
    })

    if (helper && !helperGrant({
      state,
      task: card.id,
      actor,
      action: HELPER_ACTIONS[String(action)],
    })) {
      throw new HydraError({
        message: 'This task now belongs to the main Hydra',
        code: 'MAIN_ONLY',
      })
    }

    release = taskLease({
      hydraId: host.hydraId,
      task: card.id,
      actor: helper ? actor : 'main',
    })
  }

  try {
    return await hostRequestUnlocked({
      host,
      body,
      usage,
    })
  } finally {
    release()
  }
}
