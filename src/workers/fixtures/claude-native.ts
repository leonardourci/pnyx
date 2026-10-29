import { randomUUID } from 'node:crypto'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import type { QueryFn } from '#workers/claude.ts'

// The SDK boundary consumes input independently of foreground results, as its native queue does.
export function claudeNative() {
  const incoming: SDKUserMessage[] = []
  const outgoing: SDKMessage[] = []
  let wake = () => {}, closed = false, options: Options | undefined
  let inputFailure: unknown
  let delivered = 0
  const query = (({
    prompt,
    options: provided,
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }) => {
    options = provided

    if (provided.persistSession === false) {
      return {
        supportedModels: async () => claudeRecording.models,
        close: () => {},
      }
    }

    const takeInput = async () => {
      for await (const message of prompt) {
        incoming.push(message)
      }
    }

    takeInput().catch(error => {
      inputFailure = error
      wake()
    })

    const stream = async function* () {
      while (!closed) {
        if (inputFailure) {
          throw inputFailure
        }

        const message = outgoing.shift()

        if (message) {
          yield message
          delivered++
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
        }
      }
    }

    return Object.assign(
      stream(),
      {
        close: () => {
          closed = true; wake()
        },
        interrupt: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        applyFlagSettings: async () => {},
      },
    )
  }) as unknown as QueryFn

  return {
    query,
    incoming,
    delivered: () => delivered,
    closed: () => closed,
    fail({ error }: { error: Error }) {
      inputFailure = error
      wake()
    },
    send({ message }: { message: SDKMessage }) {
      outgoing.push(message); wake()
    },
    async ask({
      id,
      input,
    }: {
      id: string
      input: Record<string, unknown>
    }) {
      if (!options?.canUseTool) {
        throw new Error('The native query has not started')
      }

      return options.canUseTool(
        'AskUserQuestion',
        input,
        {
          signal: new AbortController().signal,
          requestId: id,
          toolUseID: randomUUID(),
        },
      )
    },
  }
}
