import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EffortLevel, Options, PermissionMode, SDKMessage, SDKRateLimitInfo, Settings, query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSettings } from '../core/model.ts'
import { questions } from '../integrations/hooks/observe.ts'
import type { ModelOption, Provider } from './provider.ts'
import { attachedImages, imageType } from '../attachments/images.ts'
import { pnyxHome } from '../store/paths.ts'

export type QueryFn = typeof query
export type ReadSettings = ({ cwd }: { cwd: string }) => Promise<Settings>
type UserMessage = Parameters<QueryFn>[0]['prompt'] extends string | AsyncIterable<infer M> ? M : never
type Content = Exclude<UserMessage['message']['content'], string>

// Only the message's own images are sent, never one named in the context before it; an unreadable one stays a path.
function content({
  text,
  said,
}: {
  text: string
  said: string
}): string | Content {
  const images = attachedImages({
    text: said,
    hydras: join(
      pnyxHome(),
      'hydras',
    ),
  }).flatMap(path => {
    const media_type = imageType({ path })

    try {
      return media_type ? [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type,
            data: readFileSync(path).toString('base64'),
          },
        },
      ] : []
    } catch {
      return []
    }
  })

  return images.length ? [
    {
      type: 'text',
      text,
    },
    ...images,
  ] : text
}

const EFFORTS: readonly string[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] satisfies EffortLevel[]
const MODES: readonly string[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] satisfies PermissionMode[]
const DEFAULT_EFFORT: EffortLevel = 'high'
const DEFAULT_MODE: PermissionMode = 'default'
const CATALOG_TIMEOUT_MS = 20_000

// ponytail: folder names past 200 characters get a hash suffix we do not reproduce; the first hook corrects it.
export const transcriptPath = ({
  cwd,
  session,
  folder,
}: {
  cwd: string
  session: string
  folder?: string
}) =>
  join(
    folder || process.env.CLAUDE_CONFIG_DIR || join(
      homedir(),
      '.claude',
    ),
    'projects',
    cwd.replace(
      /[^a-zA-Z0-9]/g,
      '-',
    ),
    `${session}.jsonl`,
  )

function sdkOptions({ settings }: { settings: AgentSettings }): Partial<Options> {
  const {
    model,
    effort,
    mode,
  } = settings

  return {
    ...(model ? { model } : {}),
    ...(settings.fast !== undefined ? { settings: { fastMode: settings.fast === 'true' } } : {}),
    ...(effort && EFFORTS.includes(effort) ? { effort: effort as EffortLevel } : {}),
    ...(mode && MODES.includes(mode) ? { permissionMode: mode as PermissionMode } : {}),
    // A running session can only switch to bypass permissions if it started allowed to.
    allowDangerouslySkipPermissions: true,
  }
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'week',
  seven_day_opus: 'Opus week',
  seven_day_sonnet: 'Sonnet week',
}

// Each request reports the plan window it was checked against.
export function claudeLimit({ info }: { info: SDKRateLimitInfo }) {
  const label = LIMIT_LABELS[info.rateLimitType ?? '']

  if (!label || typeof info.utilization !== 'number') {
    return undefined
  }

  // ponytail: utilization is a 0-1 share in the events seen so far; a value past 1 is read as a percent.
  return {
    label,
    used: Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization),
    ...(info.resetsAt ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}),
  }
}

function turnOf({ message }: { message: SDKMessage }): 'working' | 'finished' | undefined {
  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return message.state === 'idle' ? 'finished' : 'working'
  }

  return message.type === 'result' ? 'finished' : undefined
}

// The settings a new session starts from, with repo-committed escalating modes dropped as Claude Code drops them.
// ponytail: read with this process's CLAUDE_CONFIG_DIR, so a second login folder's own settings are not seen.
const userSettings: ReadSettings = async ({ cwd }) => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')

  return sdk.filterEscalatingDefaultMode(await sdk.resolveSettings({
    cwd,
    settingSources: [
      'user',
      'project',
      'local',
    ],
  }))
}

export function claudeProvider({
  query,
  readSettings = userSettings,
}: {
  query?: QueryFn
  readSettings?: ReadSettings
}): Provider {
  return {
    async models({
      cwd,
      env,
    }) {
      const run = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query
      const abortController = new AbortController()
      const timer = setTimeout(
        () => abortController.abort(),
        CATALOG_TIMEOUT_MS,
      ).unref()
      const catalog = run({
        prompt: (async function* () {})(),
        options: {
          cwd,
          env,
          abortController,
          pathToClaudeCodeExecutable: 'claude',
          persistSession: false,
          settingSources: [
            'user',
            'project',
            'local',
          ],
        },
      })

      try {
        return (await catalog.supportedModels()).map(model => ({
          value: model.value,
          label: model.displayName,
          ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
          ...(model.supportsEffort ? { defaultEffort: DEFAULT_EFFORT } : {}),
        }))
      } finally {
        clearTimeout(timer)
        catalog.close()
      }
    },
    async defaults({
      cwd,
      models,
    }) {
      const own = await readSettings({ cwd }).catch((): Settings => ({}))
      const effort = ({ model }: { model: ModelOption }) =>
        own.modelSettings?.[model.resolvedModel ?? model.value]?.effortLevel
        ?? own.effortLevel ?? model.defaultEffort

      return models.map(model => ({
        ...model,
        ...(model.defaultEffort ? { defaultEffort: effort({ model }) } : {}),
        defaultMode: own.permissions?.defaultMode ?? DEFAULT_MODE,
      }))
    },
    async open({
      cwd,
      agent,
      settings,
      env,
      instructions,
      outputSchema,
      allow,
      context,
    }) {
      const id = agent?.sessionId ?? randomUUID()
      const path = agent?.transcriptPath ?? transcriptPath({
        cwd,
        session: id,
        folder: env.CLAUDE_CONFIG_DIR,
      })
      let running: ReturnType<QueryFn> | undefined
      let closed = false, interrupted = false

      return {
        id,
        path,
        async commands() {
          return running?.supportedCommands ? running.supportedCommands() : []
        },
        async* run({
          input,
          permission,
        }) {
          const run = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query

          if (closed) {
            return
          }

          // SessionStart fires too early for an SDK hook on startup and resume, so the context leads the first message.
          let fresh = true

          const prompt = async function* (): AsyncGenerator<UserMessage> {
            for await (const text of input) {
              const message = fresh && context ? `${context()}\n\n${text}` : text
              fresh = false
              yield {
                type: 'user',
                message: {
                  role: 'user',
                  content: content({
                    text: message,
                    said: text,
                  }),
                },
                parent_tool_use_id: null,
              }
            }
          }

          running = run({
            prompt: prompt(),
            options: {
              cwd,
              includePartialMessages: true,
              ...(outputSchema ? {
                outputFormat: {
                  type: 'json_schema',
                  schema: outputSchema,
                },
              } : {}),
              pathToClaudeCodeExecutable: 'claude',
              ...(agent?.resume || existsSync(path) ? { resume: id } : { sessionId: id }),
              settingSources: [
                'user',
                'project',
                'local',
              ],
              systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                ...(instructions ? { append: instructions } : {}),
              },
              tools: {
                type: 'preset',
                preset: 'claude_code',
              },
              ...(allow?.length ? { allowedTools: allow.map(command => `Bash(${command}:*)`) } : {}),
              // After a compaction, even mid-turn, the context comes back.
              ...(context ? {
                hooks: {
                  SessionStart: [
                    {
                      matcher: 'compact',
                      hooks: [
                        async () => ({
                          hookSpecificOutput: {
                            hookEventName: 'SessionStart' as const,
                            additionalContext: context(),
                          },
                        }),
                      ],
                    },
                  ],
                },
              } : {}),
              permissionPrompts: 'host',
              // eslint-disable-next-line pnyx/object-params -- The SDK owns this callback signature.
              canUseTool: async (
                tool,
                input,
                {
                  signal,
                  decisionReason,
                },
              ) => {
                const asked = tool === 'AskUserQuestion'
                  ? questions({ value: input.questions })
                  : undefined
                const decision = await permission({
                  tool,
                  input,
                  signal,
                  description: decisionReason,
                  ...(asked ? { questions: asked } : {}),
                })

                if (decision.behavior === 'deny') {
                  return decision
                }

                const picked = asked && decision.answers

                // Claude Code reads the answers keyed by question text, several picks joined as its own prompt joins them.
                return picked
                  ? {
                    behavior: 'allow',
                    updatedInput: {
                      ...input,
                      answers: Object.fromEntries(asked.map((
                        q,
                        i,
                      ) => [
                        q.question,
                        picked[i]?.join(', ') ?? '',
                      ])),
                    },
                  }
                  : { behavior: 'allow' }
              },
              env,
              ...sdkOptions({ settings }),
            },
          })

          // The SDK sends each finished block as its own message at index 0, so its text reuses the index it streamed under.
          let messageId = '', textIndex = 0, active = false
          const thinking = new Set<number>()

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
              const {
                id,
                content,
              } = message.message

              for (const [
                index,
                block,
              ] of content.entries()) {
                if (block.type === 'text') {
                  yield {
                    type: 'text' as const,
                    id: `${id}:${id === messageId && content.length === 1 ? textIndex : index}`,
                    text: block.text,
                  }
                }

                if (block.type === 'tool_use') {
                  yield {
                    type: 'tool' as const,
                    id: block.id,
                    running: true,
                  }
                }
              }
            }

            if (message.type === 'user' && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
              for (const block of message.message.content) {
                if (block.type === 'tool_result') {
                  yield {
                    type: 'tool' as const,
                    id: block.tool_use_id,
                    running: false,
                  }
                }
              }
            }

            if (message.type === 'stream_event' && !message.parent_tool_use_id) {
              const event = message.event

              if (event.type === 'message_start') {
                messageId = event.message.id
                // Each request carries the whole conversation, so its input is the context in use.
                const usage = event.message.usage

                if (usage) {
                  yield {
                    type: 'usage' as const,
                    used: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
                      + (usage.cache_read_input_tokens ?? 0),
                  }
                }
              } else if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
                thinking.add(event.index)
                yield {
                  type: 'thinking' as const,
                  id: `${messageId}:${event.index}`,
                  running: true,
                }
              } else if (event.type === 'content_block_stop' && thinking.delete(event.index)) {
                yield {
                  type: 'thinking' as const,
                  id: `${messageId}:${event.index}`,
                  running: false,
                }
              } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
                textIndex = event.index

                if (event.content_block.text) {
                  yield {
                    type: 'text' as const,
                    id: `${messageId}:${event.index}`,
                    text: event.content_block.text,
                    append: true,
                  }
                }
              } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield {
                  type: 'text' as const,
                  id: `${messageId}:${event.index}`,
                  text: event.delta.text,
                  append: true,
                }
              }
            }

            if (message.type === 'rate_limit_event') {
              const limit = claudeLimit({ info: message.rate_limit_info })

              if (limit) {
                yield {
                  type: 'usage' as const,
                  limits: [limit],
                }
              }
            }

            if (message.type === 'result') {
              if ('structured_output' in message && message.structured_output !== undefined) {
                yield {
                  type: 'structured' as const,
                  value: message.structured_output,
                }
              }

              const windows = Object.values(message.modelUsage ?? {})
                .map(model => model.contextWindow)
                .filter(size => size > 0)
              const cost = message.total_cost_usd
              const usage = 'usage' in message ? message.usage : undefined

              if (windows.length || typeof cost === 'number') {
                yield {
                  type: 'usage' as const,
                  ...(windows.length ? { window: Math.max(...windows) } : {}),
                  ...(typeof cost === 'number' ? { cost } : {}),
                  ...(usage ? {
                    inputTokens: usage.input_tokens + usage.cache_creation_input_tokens
                      + usage.cache_read_input_tokens,
                  } : {}),
                }
              }
            }

            // A turn the owner stopped ends as an error result; it is a finished turn, not a failure.
            if (message.type === 'result' && message.is_error && !interrupted) {
              throw new Error('errors' in message ? message.errors.join('; ') : 'Claude Code could not complete this turn')
            }

            if (activity === 'finished') {
              active = false
              interrupted = false
              yield 'finished'
            }
          }
        },
        async set({
          setting,
          value,
        }) {
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
        async interrupt() {
          if (running) {
            interrupted = true
            await running.interrupt()
          }
        },
        close() {
          closed = true; running?.close()
        },
      }
    },
  }
}
