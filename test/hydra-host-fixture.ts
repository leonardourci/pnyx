import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { transcriptPath, type QueryFn } from '../src/server/claude.ts'

export function hydraSdk() {
  // messages leave out the digest Pnyx puts before a session's first message; raw keeps it.
  const calls: {
    options: Options
    messages: string[]
    raw: string[]
  }[] = []
  const control = {
    hold: false,
    fail: false,
    ask: false,
    stream: false,
  }
  const permissions: PermissionResult[] = []
  const sets: string[] = []
  let release = () => {}
  const query = (({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{ message: { content: string } }>
    options: Options
  }) => {
    if (options.persistSession === false) {
      return {
        supportedModels: async () => [
          'opus',
          'sonnet',
          'haiku',
          'fable',
        ].map(value => ({
          value,
          displayName: value,
          description: '',
        })),
        close: () => {},
      }
    }

    const call = {
      options,
      messages: [] as string[],
      raw: [] as string[],
    }
    calls.push(call)
    const path = transcriptPath({
      cwd: options.cwd!,
      session: options.sessionId ?? options.resume!,
      folder: options.env?.CLAUDE_CONFIG_DIR,
    })
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    const record = ({
      role,
      text,
    }: {
      role: string
      text: string
    }) => appendFileSync(
      path,
      JSON.stringify({
        type: role,
        timestamp: new Date().toISOString(),
        message: {
          role,
          content: text,
        },
      }) + '\n',
    )

    async function* run() {
      if (control.fail) {
        throw new Error('Harness login is missing')
      }

      for await (const message of prompt) {
        const text = message.message.content
        call.raw.push(text)
        call.messages.push(text.replace(
          /^<pnyx-digest[\s\S]*?<\/pnyx-digest>\n\n/,
          '',
        ))
        record({
          role: 'user',
          text,
        })
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        }
        const reply = `Hydra: ${text.split('\n\n').at(-1)}`

        if (control.stream) {
          yield {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'message_start',
              message: { id: `reply-${call.messages.length}` },
            },
          }
          yield {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: reply.slice(
                  0,
                  8,
                ),
              },
            },
          }
        }

        if (control.ask) {
          const result = await options.canUseTool!(
            'Bash',
            { command: 'ls' },
            {
              signal: new AbortController().signal,
              toolUseID: 'hydra-tool',
              requestId: 'hydra-request',
              decisionReason: 'List the folder',
            },
          )
          permissions.push(result!)
        }

        if (control.hold) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }

        if (control.stream) {
          yield {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: reply.slice(8),
              },
            },
          }
        }

        record({
          role: 'assistant',
          text: reply,
        })
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
        }
      }
    }

    return Object.assign(
      run(),
      {
        close: () => release(),
        // eslint-disable-next-line pnyx/object-params -- The SDK owns this method signature.
        setModel: async (model: string) => {
          sets.push(`model ${model}`)
        },
        // eslint-disable-next-line pnyx/object-params -- The SDK owns this method signature.
        setPermissionMode: async (mode: string) => {
          sets.push(`mode ${mode}`)
        },
        // eslint-disable-next-line pnyx/object-params -- The SDK owns this method signature.
        applyFlagSettings: async (settings: Record<string, unknown>) => {
          sets.push(`effort ${String(settings.effortLevel)}`)
        },
      },
    )
  }) as unknown as QueryFn

  return {
    query,
    calls,
    control,
    permissions,
    sets,
    release: () => {
      control.hold = false; release()
    },
  }
}
