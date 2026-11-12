import { hydraConfig } from '#hydra/config.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import { harnessAccount } from '#workers/account-choice.ts'
import { candidates, effectiveDispatch } from '#workers/dispatch-config.ts'
import { providerIdOf } from '#workers/providers.ts'
import type { createHost } from '#app/host.ts'
import { withWriter } from '#app/writer.ts'
import type { CommandRequest } from './dispatch.ts'
import { background } from '#app/background.ts'

// `hydra-agent-change <id> inscribe|compact|neither`: settles the message held for a Hydra agent change.
export function hydraAgentChangeCommand({
  ws,
  id,
  args,
  send,
  agents,
  kick,
}: Omit<CommandRequest, 'fail'> & {
  agents: ReturnType<typeof createHost>
  kick(): void
}) {
  const choice = args[1]

  if (args.length !== 2 || (choice !== 'inscribe' && choice !== 'compact' && choice !== 'neither')) {
    throw new HydraError({
      message: 'Choose inscribe, compact or neither for the held message',
      code: 'VALIDATION_ERROR',
    })
  }

  const result = agents.changeAgent({
    id: args[0]!,
    choice,
  })
  kick()
  send({
    ws,
    message: {
      type: 'receipt',
      id,
      ...result,
    },
  })
}

// `hydra-agent <agent>`: saves the agent Hydra runs on, and hands a new permission mode to its running turn.
export function hydraAgentCommand({
  ws,
  id,
  args,
  send,
  hydraId,
  agents,
  kick,
}: Omit<CommandRequest, 'fail'> & {
  hydraId: string
  agents: ReturnType<typeof createHost>
  kick(): void
}) {
  if (args.length !== 1) {
    throw new HydraError({
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
    through,
  } = withWriter({
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
          through: writer.state.seq,
        }
      }

      if (config.hydra.kind === 'firstmate') {
        throw new HydraError({
          message: 'Firstmate manages this Hydra’s agent',
          code: 'NO_ROUTE',
        })
      }

      const decision = hydraEvent({
        state: writer.state,
        cardId: HYDRA_CARD,
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

      const running = writer.state.cards[HYDRA_CARD]?.agent

      return {
        previous: config.hydra.agent,
        running,
        through: writer.state.seq,
      }
    },
  })
  kick()

  // A new permission mode reaches Hydra's running turn at once; other settings wait for the next message.
  if (agent.mode && agent.mode !== previous?.mode && running?.host === 'pnyx'
    && running.provider === providerIdOf({ harness: agent.harness })) {
    const mode = agent.mode
    // A mode the running turn refuses stays for its next turn; the failure is logged, and the receipt still says saved.
    background({
      name: 'Hydra mode change',
      context: { hydraId },
      run: () => agents.set({
        card: HYDRA_CARD,
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
      through,
    },
  })
}
