import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EffortLevel, Options, PermissionMode, SDKMessage, query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSettings } from '../core/model.ts'
import type { Provider } from './provider.ts'

export type QueryFn = typeof query
type UserMessage = Parameters<QueryFn>[0]['prompt'] extends string | AsyncIterable<infer M> ? M : never
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'] satisfies EffortLevel[]
const MODES: readonly string[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] satisfies PermissionMode[]

// ponytail: folder names past 200 characters get a hash suffix we do not reproduce; the first hook corrects it.
export const transcriptPath = ({ cwd, session, folder }: {
  cwd: string
  session: string
  folder?: string
}) =>
  join(folder || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)

function sdkOptions({ settings }: { settings: AgentSettings }): Partial<Options> {
  const { model, effort, mode } = settings

  return {
    ...(model ? { model } : {}),
    ...(settings.fast !== undefined ? { settings: { fastMode: settings.fast === 'true' } } : {}),
    ...(effort && EFFORTS.includes(effort) ? { effort: effort as EffortLevel } : {}),
    ...(mode && MODES.includes(mode) ? { permissionMode: mode as PermissionMode } : {}),
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
  }
}

function turnOf({ message }: { message: SDKMessage }): 'working' | 'finished' | undefined {
  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return message.state === 'idle' ? 'finished' : 'working'
  }

  return message.type === 'result' ? 'finished' : undefined
}

export function claudeProvider({ query }: { query?: QueryFn }): Provider {
  return {
    async models({ cwd, env }) {
      const run = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query
      const abortController = new AbortController()
      const timer = setTimeout(() => abortController.abort(), 20000).unref()
      const catalog = run({
        prompt: (async function* () {})(),
        options: { cwd, env, abortController, pathToClaudeCodeExecutable: 'claude', persistSession: false, settingSources: ['user', 'project', 'local'] },
      })

      try {
        return (await catalog.supportedModels()).map(model => ({
          value: model.value,
          label: model.displayName,
          ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
        }))
      } finally {
        clearTimeout(timer)
        catalog.close()
      }
    },
    async open({ cwd, agent, settings, env, instructions, allow }) {
      const id = agent?.sessionId ?? randomUUID()
      const path = agent?.transcriptPath ?? transcriptPath({
        cwd, session: id, folder: env.CLAUDE_CONFIG_DIR,
      })
      let running: ReturnType<QueryFn> | undefined
      let closed = false

      return {
        id,
        path,
        async* run({ input, permission }) {
          const run = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query

          if (closed) {
            return
          }

          const prompt = async function* (): AsyncGenerator<UserMessage> {
            for await (const text of input) {
              yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
            }
          }

          running = run({
            prompt: prompt(),
            options: {
              cwd,
              includePartialMessages: true,
              pathToClaudeCodeExecutable: 'claude',
              ...(agent?.resume || existsSync(path) ? { resume: id } : { sessionId: id }),
              settingSources: ['user', 'project', 'local'],
              systemPrompt: { type: 'preset', preset: 'claude_code', ...(instructions ? { append: instructions } : {}) },
              tools: { type: 'preset', preset: 'claude_code' },
              ...(allow?.length ? { allowedTools: allow.map(command => `Bash(${command}:*)`) } : {}),
              permissionPrompts: 'host',
              // eslint-disable-next-line pnyx/object-params -- The SDK owns this callback signature.
              canUseTool: (tool, input, { signal, decisionReason }) => permission({
                tool, input, signal, description: decisionReason,
              }),
              env,
              ...sdkOptions({ settings }),
            },
          })

          let messageId = '', active = false

          for await (const message of running) {
            const activity = turnOf({ message })
            const starts = activity === 'working'
              || (message.type === 'stream_event' && !message.parent_tool_use_id && message.event.type === 'message_start')
              || (message.type === 'assistant' && !message.parent_tool_use_id)

            if (starts && !active) {
              active = true
              yield 'working'
            }

            if (message.type === 'assistant' && !message.parent_tool_use_id) {
              for (const [index, block] of message.message.content.entries()) {
                if (block.type === 'text') {
                  yield { type: 'text' as const, id: `${message.message.id}:${index}`, text: block.text }
                }
              }
            }

            if (message.type === 'stream_event' && !message.parent_tool_use_id) {
              const event = message.event

              if (event.type === 'message_start') {
                messageId = event.message.id
              } else if (event.type === 'content_block_start' && event.content_block.type === 'text' && event.content_block.text) {
                yield { type: 'text' as const, id: `${messageId}:${event.index}`, text: event.content_block.text, append: true }
              } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield { type: 'text' as const, id: `${messageId}:${event.index}`, text: event.delta.text, append: true }
              }
            }

            if (message.type === 'result' && message.is_error) {
              throw new Error('errors' in message ? message.errors.join('; ') : 'Claude Code could not complete this turn')
            }

            if (activity === 'finished') {
              active = false
              yield 'finished'
            }
          }
        },
        async set({ setting, value }) {
          if (!running) {
            throw new Error('Claude Code is still loading')
          }

          if (setting === 'model') {
            await running.setModel(value)
          } else if (setting === 'mode') {
            await running.setPermissionMode(value as PermissionMode)
          } else if (setting === 'effort') {
            await running.applyFlagSettings({ effortLevel: value as EffortLevel })
          }
        },
        close() {
          closed = true; running?.close()
        },
      }
    },
  }
}
