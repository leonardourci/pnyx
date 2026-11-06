import { applyDecision } from '#app/decision.ts'
import type { Host, Live } from '#app/host-types.ts'
import { hydraActor } from '#app/request-context.ts'
import type { Writer } from '#app/writer.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import type { Card } from '#tasks/model.ts'
import { harnessControls } from './controls.ts'
import type { AgentRef } from './model.ts'
import { nativeIdle } from './native-session.ts'
import { agentPermissionNeedsOwner } from './permission-level.ts'
import { sessionId } from './session-attachments.ts'

// A setting changed on a hosted agent: recorded, applied to its live process, or the process replaced once it settles.
export function createLiveSettings({
  live,
  at,
  write,
  hosted,
  record,
  retire,
}: {
  live: Map<string, Live>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  hosted({
    writer,
    ref,
  }: {
    writer: Writer
    ref: string
  }): Card & { agent: AgentRef }
  record({
    writer,
    agent,
    input,
    actor,
  }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
  }): void
  retire({
    key,
    entry,
  }: {
    key: string
    entry: Live
  }): void
}) {
  const set: Host['set'] = async ({
    card: ref,
    setting,
    value,
    actor,
  }) => {
    const card = write({
      fn: ({ writer }) => {
        const card = hosted({
          writer,
          ref,
        })
        const controls = harnessControls({
          provider: card.agent.provider,
          hosted: true,
        })
        const control = controls?.controls.find(c => c.setting === setting)

        if (!control || !control.options.some(o => o.value === value)) {
          throw new HydraError({
            message: `${setting} cannot be ${value}`,
            code: 'VALIDATION_ERROR',
          })
        }

        if (hydraActor({ actor }) && setting === 'mode' && agentPermissionNeedsOwner({
          card,
          value,
        })) {
          throw new HydraError({
            message: 'Only the owner can raise an agent’s permission level',
            code: 'OWNER_ONLY',
          })
        }

        record({
          writer,
          agent: card.agent,
          input: { settings: { [setting]: value } },
          actor,
        })

        const usedAgent = writer.state.hydraAgent

        // Wakes retain this agent, so permission controls must update its saved mode too.
        if (card.id === HYDRA_CARD && setting === 'mode' && usedAgent && usedAgent.mode !== value) {
          applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              cardId: HYDRA_CARD,
              meta: {
                at: at(),
                actor,
              },
              change: {
                type: 'hydra.agent-used',
                data: {
                  ...usedAgent,
                  mode: value,
                },
              },
            }),
          })
        }

        return card
      },
    })
    const key = sessionId({ agent: card.agent })
    const running = live.get(key)

    if (!running) {
      return
    }

    try {
      if (!running.session) {
        throw new Error('Provider is still loading')
      }

      await running.session.set({
        setting,
        value,
      })
    } catch {
      // Some settings require replacing the process after its native work settles.
      running.stale = true

      const settled = running.session && nativeIdle({ work: running.session.snapshot().work })

      if (running.activity !== 'working' && settled) {
        retire({
          key,
          entry: running,
        })
      }
    }
  }

  return { set }
}
