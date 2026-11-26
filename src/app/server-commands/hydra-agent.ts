import { background } from '#app/background.ts'
import { hydraConfig } from '#titan/config.ts'
import { hydraEvent } from '#titan/titan.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { candidates, effectiveDispatch } from '#workers/dispatch-config.ts'
import { providerIdOf } from '#workers/providers.ts'
import type { createHost } from '#app/host.ts'
import { withWriter } from '#app/writer.ts'
import type { CommandRequest } from './dispatch.ts'

// `hydra-agent <agent>`: saves the agent Titan runs on, and hands a new permission mode to its running turn.
export async function hydraAgentCommand({
  ws,
  id,
  args,
  send,
  hydraId,
  agents,
  kick,
}: CommandRequest & {
  hydraId: string
  agents: ReturnType<typeof createHost>
  kick(): void
}) {
  if (args.length !== 1) {
    throw new TitanError({
      message: 'hydra-agent expects one agent configuration',
      code: 'VALIDATION_ERROR',
    })
  }

  const agent = candidates({ value: [JSON.parse(args[0]!)] })[0]!

  if (agent.account) {
    // Refuses an account not registered for this harness.
    harnessAccount({
      effective: effectiveDispatch(),
      harness: agent.harness,
      prefer: agent.account,
    })
  }

  const {
    previous,
    running,
    stateSeq,
  } = await withWriter({
    hydraId,
    fn: ({ writer }) => {
      const config = hydraConfig({
        state: writer.state,
        id: hydraId,
      })

      if (Object.hasOwn(
        writer.state.eventIds,
        id,
      )) {
        return {
          previous: config.hydra.agent,
          running: undefined,
          stateSeq: writer.state.seq,
        }
      }

      const decision = hydraEvent({
        state: writer.state,
        cardId: TITAN_CARD,
        meta: {
          id,
          at: new Date().toISOString(),
          actor: 'web',
        },
        change: {
          type: 'board.configured',
          data: {
            ...config,
            hydra: {
              ...config.hydra,
              agent,
            },
          },
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }

      const running = writer.state.cards[TITAN_CARD]?.agent

      return {
        previous: config.hydra.agent,
        running,
        stateSeq: writer.state.seq,
      }
    },
  })
  kick()

  // A new permission mode reaches Titan's running turn at once; other settings wait for the next message.
  if (agent.mode && agent.mode !== previous?.mode && running?.host === 'othrys'
    && running.provider === providerIdOf({ harness: agent.harness })) {
    const mode = agent.mode
    // A mode the running turn refuses stays for its next turn; the failure is logged, and the receipt still says saved.
    background({
      name: 'Titan mode change',
      context: { hydraId },
      run: () => agents.set({
        card: TITAN_CARD,
        setting: 'mode',
        value: mode,
        actor: 'web',
      }),
    })
  }

  send({
    ws,
    message: {
      type: 'receipt',
      id,
      saved: true,
      stateSeq,
    },
  })
}
