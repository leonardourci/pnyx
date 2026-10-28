import type { Host } from './host-types.ts'
import { isHelper, taskLease } from '#routine-helper/leases.ts'
import { HydraError } from '#store/errors.ts'
import { loadHydra } from './store.ts'
import { findCard } from '#tasks/push-rules.ts'
import { helperGrant, type HelperAction } from '#routine-helper/route.ts'
import { isAbsolute } from 'node:path'
import { field } from '#workers/http.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { overrideOf, ruleCandidates, validateChoice, chooseCandidate, hostedOverride, chosenSettings, readQuota } from '#workers/dispatch.ts'
import { catalogOffers, providerName } from '#workers/model-catalog.ts'
import { modelIds } from '#workers/provider.ts'
import { hydraMode } from '#hydra/hydra.ts'
import { findOption } from '#workers/controls.ts'
import { SETTINGS } from '#workers/host.ts'

// The host actions a helper may request, by the named helper action each one is.
const HELPER_ACTIONS: Record<string, HelperAction> = {
  send: 'reply',
  continue: 'continue',
  permission: 'permission',
}

export async function hostRequestUnlocked({
  host,
  body: raw,
}: {
  host: Host
  body: unknown
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

    case 'usage':
      return host.usage()

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
      const config = effectiveDispatch({
        hydraId: host.hydraId,
        state: current,
      })
      const rule = field({
        body,
        name: 'rule',
        optional: true,
      })
      const harness = field({
        body,
        name: 'harness',
        optional: true,
      })
      const override = overrideOf({ value: body.override })
      const named = (ruleCandidates({
        dispatch: config.dispatch,
        rule,
      }) ?? []).filter(c => c.model)
      const dispatch = body.dispatch
        ? validateChoice({
          value: body.dispatch,
          config,
          project,
        })
        : chooseCandidate({
          config,
          project,
          rule,
          harness,
          override,
          offers: await catalogOffers({
            host,
            harnesses: harness === 'claude' || harness === 'codex' ? [harness] : override?.model ? [
              'claude',
              'codex',
            ] : named.map(c => c.harness),
          }),
        })

      hostedOverride({
        harness: dispatch.provider,
        override: dispatch.override,
      })

      if (dispatch.ownerOverride) {
        const settings = chosenSettings({ choice: dispatch })

        if (settings.model) {
          const models = modelIds({ models: await host.models({ harness: dispatch.provider }) })
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

        if (readQuota({
          account: {
            provider: dispatch.provider,
            folder: dispatch.folder,
          },
        }).auth === 'signed-out') {
          throw new HydraError({
            message: `account ${dispatch.account} is signed out`,
            code: 'ACCOUNT_SIGNED_OUT',
          })
        }
      }

      // A setting changed after the start would reach only the next turn.
      const settings: Record<string, string> = {
        ...chosenSettings({ choice: dispatch }),
        provider: providerName({ harness: dispatch.provider }),
      }
      const inherited = hydraMode({ state: current })

      // A rule without a mode inherits Hydra's; never plan, which would stall a worker.
      if (!settings.mode && inherited && inherited !== 'plan'
        && findOption({
          provider: settings.provider,
          setting: 'mode',
          value: inherited,
          hosted: true,
        })) {
        settings.mode = inherited
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
      const harness = field({
        body,
        name: 'harness',
      })

      if (harness !== 'claude' && harness !== 'codex') {
        throw new HydraError({
          message: 'models expects claude or codex',
          code: 'VALIDATION_ERROR',
        })
      }

      return { models: await host.models({ harness }) }
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
}: {
  host: Host
  body: unknown
}): Promise<Record<string, unknown>> {
  const request = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const actor = typeof request.actor === 'string' ? request.actor : 'cli'
  const helper = isHelper({ actor })
  const action = request.action

  if (helper && !(String(action) in HELPER_ACTIONS)) {
    throw new HydraError({
      message: 'This action belongs to the main Hydra',
      code: 'MAIN_ONLY',
    })
  }

  const ref = request.task ?? request.card
  let release = () => {}

  if (typeof ref === 'string' && [
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
    })
  } finally {
    release()
  }
}
