import { SESSION_TITLE, type Note, type SourceNote } from '#tasks/model.ts'
import type { FoundSettings, TranscriptRecord, TranscriptReader } from './provider.ts'
import { blockText, foundSettings, onOff, transcriptCall, transcriptString, transcriptText, transcriptTrace, trimmedString } from './transcript-content.ts'
import { existsSync } from 'node:fs'
// Loaded with the server, so a server waiting to restart after an upgrade never loads the newly installed SDK into its old code.
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EffortLevel, Options, PermissionMode, SDKMessage, SDKRateLimitInfo, Settings, query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSettings } from './model.ts'
import { questions } from './native-prompts.ts'
import { object, count, usageNumber, taskContext, textContent } from './transcript-usage.ts'
import type { TranscriptUsageReader, HostedImage, ModelOption, Provider } from './provider.ts'
import { nativeSession, type NativeSession } from './native-session.ts'
import { imageBytes } from './input.ts'
import { compactCommand } from './compact-command.ts'

export type QueryFn = typeof query
export type ReadSettings = ({ cwd }: { cwd: string }) => Promise<Settings>
type UserMessage = Parameters<QueryFn>[0]['prompt'] extends string | AsyncIterable<infer M> ? M : never
type Content = Exclude<UserMessage['message']['content'], string>

function content({
  text,
  images,
}: {
  text: string
  images: HostedImage[]
}): string | Content {
  if (images.length === 0) {
    return text
  }

  return [
    {
      type: 'text',
      text,
    },
    ...images.map(image => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType,
        data: imageBytes({ image }).toString('base64'),
      },
    })),
  ]
}

function consumedInputs({
  message,
  nativeInputs,
}: {
  message: SDKMessage
  nativeInputs: Map<string, string>
}): string[] {
  let ids: string[] = []

  if ('user_message_uuids' in message && message.user_message_uuids) {
    ids = message.user_message_uuids
  } else if ('user_message_uuid' in message && message.user_message_uuid) {
    ids = [message.user_message_uuid]
  }

  return ids.flatMap(id => {
    const input = nativeInputs.get(id)

    return input ? [input] : []
  })
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
    compact: true,
    async models({
      cwd,
      env,
    }) {
      const run = query ?? sdk.query
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
          ...(model.supportsFastMode ? { fast: true as const } : {}),
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
      spawned,
    }) {
      const id = agent?.sessionId ?? randomUUID()
      const path = agent?.transcriptPath ?? transcriptPath({
        cwd,
        session: id,
        folder: env.CLAUDE_CONFIG_DIR,
      })
      let spawnProcess: Options['spawnClaudeCodeProcess']

      if (spawned) {
        spawnProcess = ({
          command,
          args,
          cwd,
          env,
          signal,
        }) => {
          const child = spawn(
            command,
            args,
            {
              cwd,
              env,
              signal,
              stdio: 'pipe',
              // Its own process group, so a later start can stop it together with the tools it ran.
              detached: true,
            },
          )

          // The SDK's custom process contract leaves stderr consumption to the caller.
          child.stderr.resume()
          spawned({ child })

          return child
        }
      }

      let running: ReturnType<QueryFn> | undefined
      let closed = false, interrupted = false

      const native: NativeSession = {
        id,
        path,
        async commands() {
          return running?.supportedCommands ? running.supportedCommands() : []
        },
        async* run({
          input,
          permission,
          emit,
        }) {
          const run = query ?? sdk.query

          if (closed) {
            return
          }

          // SessionStart fires too early for an SDK hook on startup and resume, so the context leads the first message.
          let fresh = true, manualCompact = false

          const nativeInputs = new Map<string, string>()

          const prompt = async function* (): AsyncGenerator<UserMessage> {
            for await (const item of input) {
              const { text } = item
              const compact = compactCommand({ text })
              manualCompact ||= compact
              const message = fresh && context && !compact ? `${await context()}\n\n${text}` : text

              if (!compact) {
                fresh = false
              }

              const uuid = randomUUID()
              nativeInputs.set(
                uuid,
                item.id,
              )
              emit({
                event: {
                  type: 'input',
                  receipt: {
                    inputId: item.id,
                    phase: 'taken',
                  },
                },
              })
              yield {
                type: 'user',
                uuid,
                message: {
                  role: 'user',
                  content: content({
                    text: message,
                    images: item.images,
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
              spawnClaudeCodeProcess: spawnProcess,
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
                            additionalContext: await context(),
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
                  requestId,
                },
              ) => {
                const asked = tool === 'AskUserQuestion'
                  ? questions({ value: input.questions })
                  : undefined
                const decision = await permission({
                  id: requestId,
                  tool,
                  input,
                  signal,
                  description: decisionReason,
                  ...(asked ? { questions: asked } : {}),
                })

                emit({
                  event: {
                    type: 'answer-submitted',
                    id: requestId,
                  },
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
          let messageId = '', textIndex = 0, active = false, turnId = randomUUID()
          let compaction: {
            id: string
            trigger: 'manual' | 'auto'
          } | undefined
          const thinking = new Set<number>()

          for await (const message of running) {
            if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
              emit({
                event: {
                  type: 'background',
                  background: {
                    knowledge: 'known',
                    tasks: message.tasks.map(task => ({
                      id: task.task_id,
                      type: task.task_type,
                    })),
                  },
                },
              })
            }

            if (message.type === 'system' && message.subtype === 'status') {
              if (message.status === 'compacting') {
                // Claude Code repeats this status every 30 seconds under a new uuid; it is one compaction until its result.
                compaction ??= {
                  id: message.uuid ?? randomUUID(),
                  trigger: manualCompact ? 'manual' : 'auto',
                }
                manualCompact = false

                if (!active) {
                  active = true
                  turnId = randomUUID()
                  emit({
                    event: {
                      type: 'turn-started',
                      turn: turnId,
                    },
                  })
                  yield 'working'
                }

                yield {
                  type: 'compaction' as const,
                  ...compaction,
                  state: 'running' as const,
                }
              } else if (message.compact_result && compaction) {
                const state = message.compact_result === 'success' ? 'done' : interrupted ? 'cancelled' : 'failed'
                yield {
                  type: 'compaction' as const,
                  ...compaction,
                  state,
                  ...(state === 'failed' && message.compact_error ? { error: message.compact_error } : {}),
                }
                compaction = undefined
              }
            }

            const activity = turnOf({ message })
            const starts = activity === 'working'
            || (message.type === 'stream_event' && !message.parent_tool_use_id && message.event.type === 'message_start')
            || (message.type === 'assistant' && !message.parent_tool_use_id)

            const started = starts && !active

            if (started) {
              active = true
              turnId = randomUUID()
              emit({
                event: {
                  type: 'turn-started',
                  turn: turnId,
                },
              })
            }

            for (const inputId of consumedInputs({
              message,
              nativeInputs,
            })) {
              emit({
                event: {
                  type: 'input',
                  receipt: {
                    inputId,
                    phase: 'confirmed',
                    turn: turnId,
                  },
                },
              })
            }

            if (started) {
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
                    tool: block.name,
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

            if (message.type === 'result') {
              const inputIds = consumedInputs({
                message,
                nativeInputs,
              })

              let status: 'completed' | 'interrupted' | 'failed' = 'completed'
              let error: string | undefined

              if (interrupted) {
                status = 'interrupted'
              } else if (message.is_error) {
                status = 'failed'
                error = 'errors' in message ? message.errors.join('; ') : 'Claude Code could not complete this turn'
              }

              emit({
                event: {
                  type: 'result',
                  turn: turnId,
                  inputIds,
                  status,
                  error,
                  queued: message.queued_turn_count,
                  final: 'result' in message ? message.result : undefined,
                },
              })

              active = false
              turnId = randomUUID()

              for (const [
                native,
                input,
              ] of nativeInputs) {
                if (inputIds.includes(input)) {
                  nativeInputs.delete(native)
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
              manualCompact = false
              compaction = undefined
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

      return nativeSession({ native })
    },
  }
}

export function readClaudeUsage({
  reader,
  value,
}: {
  reader: TranscriptUsageReader
  value: unknown
}): void {
  const record = object({ value })
  const message = object({ value: record.message })
  const at = typeof record.timestamp === 'string' ? record.timestamp : undefined
  const {
    rows,
    messages,
  } = reader

  if (record.type === 'user' && !record.toolUseResult) {
    reader.tasks = taskContext({ text: textContent({ value: message.content }) })
  }

  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    reader.current = {}

    return
  }

  if (message.model === '<synthetic>') {
    return
  }

  const usage = object({ value: message.usage })

  if (record.type !== 'assistant' || typeof message.id !== 'string' || !Object.keys(usage).length) {
    return
  }

  const tokens = count({ value: usage.input_tokens }) + count({ value: usage.output_tokens })
      + count({ value: usage.cache_read_input_tokens })
      + count({ value: usage.cache_creation_input_tokens })
  const index = messages.get(message.id)
  const row = {
    at,
    tokens,
    tasks: [...reader.tasks],
  }

  if (index === undefined) {
    messages.set(
      message.id,
      rows.length,
    )
    rows.push(row)
  } else if (rows[index]!.tokens < tokens) {
    rows[index] = row
  }

  const contextCounts = [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ]
  const reportedContext = contextCounts.some(value =>
    usageNumber({
      value,
      integer: true,
    }) !== undefined)

  if (reportedContext) {
    reader.current.used = count({ value: usage.input_tokens })
      + count({ value: usage.cache_read_input_tokens })
      + count({ value: usage.cache_creation_input_tokens })
  }
}

function claudeSettings(
  {
    record,
    subagent,
  }: {
    record: Record<string, unknown>
    subagent: boolean
  },
): FoundSettings | undefined {
  // A subagent's own transcript contains sidechain records, so its settings are read there.
  if (record.isSidechain === true && !subagent) {
    return undefined
  }

  // Separate permission-mode records retain the starting mode after a live mode change.
  if (record.type === 'user') {
    return foundSettings({ settings: { mode: transcriptString({ value: record.permissionMode }) } })
  }

  if (record.type !== 'assistant') {
    return undefined
  }

  const message = object({ value: record.message })
  const model = transcriptString({ value: message.model })
  const speed = transcriptString({ value: object({ value: message.usage }).speed })
  const requested = transcriptString({ value: record.requestedModel })

  return foundSettings({
    settings: {
      model: model?.startsWith('<') ? undefined : model,
      effort: transcriptString({ value: record.effort }),
      fast: onOff({ fast: speed === undefined ? undefined : speed === 'fast' }),
      context: requested === undefined ? undefined : /\[1m\]$/i.test(requested) ? '1M' : null,
      client: transcriptString({ value: record.entrypoint }),
      version: transcriptString({ value: record.version }),
    },
  })
}

const COMPACT_PREAMBLE = /^This session is being continued from a previous conversation[^\n]*\n+(?:Summary:\s*\n)?/

type Rec = {
  type?: unknown
  uuid?: unknown
  timestamp?: unknown
  isCompactSummary?: unknown
  summary?: unknown
  leafUuid?: unknown
  customTitle?: unknown
  aiTitle?: unknown
  message?: { content?: unknown }
  toolUseResult?: unknown
}

function contentText({ content }: { content: unknown }): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map(b => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

function answers({
  r,
  at,
}: {
  r: Rec
  at: string | undefined
}): SourceNote[] {
  const result = r.toolUseResult as {
    questions?: unknown
    answers?: unknown
    annotations?: unknown
  } | undefined

  if (typeof result !== 'object' || result === null || !Array.isArray(result.questions)) {
    return []
  }

  const given = result.answers

  if (typeof given !== 'object' || given === null) {
    return []
  }

  const content = r.message?.content
  const blocks = Array.isArray(content) ? content as { tool_use_id?: unknown }[] : []
  const call = blocks.find(b => trimmedString({ value: b?.tool_use_id }))
  const id = trimmedString({ value: call?.tool_use_id }) ?? trimmedString({ value: r.uuid })

  if (!id) {
    return []
  }

  const notes = (result.annotations ?? {}) as Record<string, { notes?: unknown } | undefined>

  return result.questions.flatMap((
    q: { question?: unknown },
    i: number,
  ) => {
    const question = trimmedString({ value: q?.question })
    const answer = question && trimmedString({
      value: (given as Record<string, unknown>)[question],
    })

    if (!question || !answer) {
      return []
    }

    const note = trimmedString({ value: notes[question]?.notes })
    const text = [
      question,
      `Answer: ${answer}`,
      ...(note ? [`Notes: ${note}`] : []),
    ].join('\n')

    return [
      {
        kind: 'decision' as const,
        source: 'claude-code',
        text,
        ref: `ask:${id}:${i}`,
        ...(at ? { at } : {}),
      },
    ]
  })
}

function claudeTranscriptNotes({ record }: { record: unknown }): SourceNote[] {
  const r = record as Rec | null

  if (typeof r !== 'object' || r === null) {
    return []
  }

  const at = trimmedString({ value: r.timestamp })
  const note = ({
    kind,
    source,
    text,
    ref,
  }: {
    kind: Note['kind']
    source: string
    text: string | undefined
    ref: string
  }): SourceNote[] =>
    text ? [
      {
        kind,
        source,
        text,
        ref,
        ...(at ? { at } : {}),
      },
    ] : []

  switch (r.type) {
    case 'user':
      if (r.isCompactSummary === true) {
        const text = trimmedString({
          value: contentText({ content: r.message?.content }).replace(
            COMPACT_PREAMBLE,
            '',
          ),
        })

        return note({
          kind: 'summary',
          source: 'claude-code',
          text,
          ref: `compact:${trimmedString({ value: r.uuid }) ?? text}`,
        })
      }

      return answers({
        r,
        at,
      })
    case 'summary': {
      const text = trimmedString({ value: r.summary })

      return note({
        kind: 'summary',
        source: 'claude-code',
        text,
        ref: `summary:${trimmedString({ value: r.leafUuid }) ?? ''}:${text}`,
      })
    }
    case 'custom-title':
    case 'ai-title': {
      const title = trimmedString({ value: r.customTitle }) ?? trimmedString({ value: r.aiTitle })

      return note({
        kind: 'context',
        source: 'claude-code',
        text: title && `${SESSION_TITLE}${title}`,
        ref: `title:${title}`,
      })
    }
    default:
      return []
  }
}

export const readClaudeTranscript: TranscriptReader = ({
  record,
  subagent = false,
}) => {
  if (typeof record !== 'object' || record === null || 'payload' in record) {
    return undefined
  }

  const entry = object({ value: record })
  const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
  const parsed: TranscriptRecord = {
    role: String(entry.type),
    at,
    messages: [],
    traces: [],
    calls: [],
    results: [],
    notes: claudeTranscriptNotes({ record }),
    settings: claudeSettings({
      record: entry,
      subagent,
    }),
  }

  if (entry.isMeta === true) {
    return parsed
  }

  const content = object({ value: entry.message }).content
  const blocks = Array.isArray(content) ? content : []

  if (entry.isCompactSummary !== true && (entry.type === 'user' || entry.type === 'assistant')) {
    const texts = typeof content === 'string' ? [content] : blocks
    parsed.messages = transcriptText({
      at,
      texts: texts.map(raw => ({ text: blockText({ value: raw }) })),
    })
  }

  for (const [
    index,
    raw,
  ] of blocks.entries()) {
    const block = object({ value: raw })
    const tool = block.type === 'tool_use' || block.type === 'tool_result'
    const thinking = block.type === 'thinking'

    if (tool || thinking) {
      parsed.traces.push(transcriptTrace({
        index,
        kind: tool ? 'tool' : 'thinking',
        name: block.name,
        detail: block.thinking ?? block.content ?? block.input,
        call: block.tool_use_id ?? block.id,
      }))
    }

    if (entry.isSidechain === true) {
      continue
    }

    if (block.type === 'tool_use' && typeof block.id === 'string') {
      parsed.calls.push(transcriptCall({
        id: block.id,
        tool: block.name,
        input: object({ value: block.input }),
      }))
    }

    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      parsed.results.push(block.tool_use_id)
    }
  }

  return parsed
}
