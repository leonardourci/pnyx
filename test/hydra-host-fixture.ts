import { mkdirSync, appendFileSync, utimesSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { transcriptPath, type QueryFn } from '../src/server/claude.ts'

export function hydraSdk({ now }: { now?: () => number } = {}) {
  // messages leave out the digest Pnyx puts before a session's first message; raw keeps it.
  const calls: {
    options: Options
    messages: string[]
    raw: string[]
  }[] = []
  const control = {
    onInput: undefined as (({ text }: { text: string }) => void) | undefined,
    hold: false,
    compactFailure: undefined as string | undefined,
    compactUnreported: false,
    fail: false,
    ask: false,
    stream: false,
    delayInputRecord: false,
    leaveTurnUnfinishedOnClose: false,
    usage: undefined as {
      context: number
      window: number
      cost: number
      // A plan window the agent reports for its request, as Claude Code's rate limit event does.
      limit?: {
        rateLimitType: string
        utilization: number
        resetsAt: number
      }
    } | undefined,
    reply: undefined as string | undefined,
    // Ends each turn with this error result, as the SDK does for a turn that fails.
    turnError: undefined as string | undefined,
    // Runs a tool call across the held part of the turn.
    tool: false,
    // With tool, the call's result comes before the hold, so the held part is quiet.
    toolDone: false,
  }
  const permissions: PermissionResult[] = []
  const sets: string[] = []
  const interrupts: unknown[] = []
  const releases = new Set<() => void>()
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

    let release = () => {}, interrupted = false
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
    }) => {
      appendFileSync(
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

      if (now) {
        const at = new Date(now())
        utimesSync(
          path,
          at,
          at,
        )
      }
    }

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
        control.onInput?.({ text })
        const delayInputRecord = control.delayInputRecord

        if (!delayInputRecord) {
          record({
            role: 'user',
            text,
          })
        }

        if (text.trim() === '/compact') {
          yield {
            type: 'system',
            subtype: 'status',
            status: 'compacting',
            uuid: `compact-${call.messages.length}`,
          }

          if (control.hold) {
            await new Promise<void>(resolve => {
              release = resolve; releases.add(resolve)
            })
          }

          if (!control.compactUnreported) {
            yield {
              type: 'system',
              subtype: 'status',
              status: null,
              compact_result: interrupted || control.compactFailure ? 'failed' : 'success',
              compact_error: interrupted ? 'Request was aborted.' : control.compactFailure,
            }
          }

          interrupted = false
          yield {
            type: 'result',
            is_error: false,
          }
          continue
        }

        yield {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
        }
        const reply = control.reply ?? `Hydra: ${text.split('\n\n').at(-1)}`

        if (control.usage?.limit) {
          yield {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed',
              ...control.usage.limit,
            },
          }
        }

        if (control.usage) {
          yield {
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'message_start',
              message: {
                id: `usage-${call.messages.length}`,
                usage: {
                  input_tokens: 10,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: control.usage.context - 10,
                  output_tokens: 1,
                },
              },
            },
          }
        }

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

        const tool = control.tool ? `tool-${call.messages.length}` : undefined
        const toolDoneEarly = control.toolDone
        const toolResult = {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: tool,
                content: 'ok',
              },
            ],
          },
        } as const

        if (tool) {
          yield {
            type: 'assistant',
            parent_tool_use_id: null,
            message: {
              id: tool,
              content: [
                {
                  type: 'tool_use',
                  id: tool,
                  name: 'Bash',
                  input: { command: 'pnpm test' },
                },
              ],
            },
          }
        }

        if (tool && toolDoneEarly) {
          yield toolResult
        }

        if (control.hold) {
          await new Promise<void>(resolve => {
            release = () => {
              releases.delete(release)
              resolve()
            }

            releases.add(release)
          })
        }

        if (delayInputRecord) {
          record({
            role: 'user',
            text,
          })
        }

        if (tool && !toolDoneEarly) {
          yield toolResult
        }

        // The SDK ends an interrupted turn with an error result.
        if (interrupted) {
          interrupted = false
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['Request was aborted.'],
          }

          continue
        }

        if (control.turnError) {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: [control.turnError],
          }

          continue
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

        if (control.usage) {
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            total_cost_usd: control.usage.cost,
            modelUsage: { 'claude-sonnet': { contextWindow: control.usage.window } },
          }
        }

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
        close: () => {
          if (!control.leaveTurnUnfinishedOnClose) {
            release()
          }
        },
        interrupt: async () => {
          interrupts.push(call)
          interrupted = true
          release()
        },
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
    interrupts,
    release: () => {
      control.hold = false

      for (const release of releases) {
        release()
      }
    },
  }
}
