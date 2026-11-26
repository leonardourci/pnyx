// Fake Claude Code and Codex replaying a real recorded turn (`pnpm refresh-agent-fixtures`), so Othrys's provider code runs as in use.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { ModelInfo, Options, PermissionResult, SDKControlGetContextUsageResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { transcriptPath, type QueryFn } from '#workers/claude.ts'
import type { SpawnCodex } from '#workers/codex.ts'

type Message = Record<string, unknown>

const recording = <T>({ name }: { name: string }) => JSON.parse(readFileSync(
  join(
    import.meta.dirname,
    'fixtures',
    'agents',
    name,
  ),
  'utf8',
)) as T

const claudeRecording = recording<{
  models: ModelInfo[]
  context: Pick<SDKControlGetContextUsageResponse, 'model' | 'rawMaxTokens'>
  turn: SDKMessage[]
}>({ name: 'claude.json' })
const codexRecording = recording<{
  session: ({
    method: string
    result: Message
  } | { notification: Message })[]
}>({ name: 'codex.json' })

// One agent session as Othrys started it, and everything it heard.
export interface AgentSession {
  id: string
  provider: 'claude' | 'codex'
  resumed: boolean
  cwd: string
  env: NodeJS.ProcessEnv
  received: string[]
  contexts?: string[]
  uuids: (string | undefined)[]
  // Received messages whose turn ended.
  answered: number
  closed: boolean
  model?: string
  effort?: string
  // Provider options Othrys supplied when opening the session.
  config?: Record<string, unknown>
  instructions?: string
  // Claude: the agent calls a tool that needs permission mid-turn and gets Othrys's decision.
  useTool?({
    tool,
    input,
    signal,
  }: {
    tool: string
    input: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<PermissionResult | null>
}

interface TurnPlan {
  // The next prompt ending with this text, or the one match accepts, takes the plan.
  text?: string
  match?({ text }: { text: string }): boolean
  reply?: string
  splitReply?: boolean
  partial?: string
  hold?: boolean
  acknowledgeStartAfter?: Promise<void>
  refusalReason?: string
  // Claude reports a compaction that lasts until the turn's release, as /compact does; with compactTo it finishes at once.
  compacting?: boolean
  // Compacts to this many tokens: Claude (with compacting) then ends the turn as /compact does once released or stopped; Codex compacts just before the turn ends.
  compactTo?: number
  // Claude Code measures the session against this window from this turn on, as after a model switch.
  window?: number
  // Claude folds a message sent while the turn waits into it at once, as Claude Code does at a step boundary; its transcript record waits for the turn's end.
  folds?: boolean
  // Codex answers the turn start with an error, so the agent never takes the message.
  refuse?: boolean
  tool?: {
    id: string
    name: string
    input: Record<string, unknown>
  }
}

interface Plan extends TurnPlan {
  hydra?: string
  wait: Promise<void>
  release(): void
}

function plans() {
  const waiting: Plan[] = []

  return {
    plan: ({
      hydra,
      hold,
      ...turn
    }: TurnPlan & { hydra?: string }) => {
      let release = () => {}
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      waiting.push({
        ...turn,
        hydra,
        wait,
        release,
      })

      if (!hold) {
        release()
      }

      return { release }
    },
    take: ({
      text,
      env,
    }: {
      text: string
      env: NodeJS.ProcessEnv
    }) => {
      const at = waiting.findIndex(plan => (!plan.hydra || plan.hydra === env.OTHRYS_TITAN)
        && (plan.match ? plan.match({ text }) : text.endsWith(plan.text ?? '')))

      return at === -1 ? undefined : waiting.splice(
        at,
        1,
      )[0]
    },
  }
}

const textOf = ({ message }: { message: SDKUserMessage }) => {
  const { content } = message.message

  return typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function assistantRecord() {
  const found = claudeRecording.turn.find(m => m.type === 'assistant')

  if (!found) {
    throw new Error('The recorded Claude turn holds no assistant message')
  }

  return found
}

export function fakeClaude() {
  const sessions: AgentSession[] = []
  const turns = plans()
  const recordedReply = claudeRecording.turn.flatMap(m => m.type === 'assistant'
    ? m.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : []).join('')
  const recordedAssistant = assistantRecord()
  const models: {
    list: ModelInfo[]
    failure?: string
  } = { list: claudeRecording.models }

  const query = (({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }) => {
    // A model catalog read opens no session.
    if (options.persistSession === false) {
      return {
        supportedModels: async () => {
          if (models.failure) {
            throw new Error(models.failure)
          }

          return models.list
        },
        close: () => {},
      }
    }

    if (!options.env?.OTHRYS_HOME) {
      throw new Error('a fake agent started without its own OTHRYS_HOME')
    }

    const id = options.sessionId ?? options.resume!
    let stop: (() => void) | undefined
    const session: AgentSession = {
      id,
      provider: 'claude',
      resumed: Boolean(options.resume),
      cwd: options.cwd!,
      env: options.env,
      received: [],
      contexts: [],
      uuids: [],
      answered: 0,
      closed: false,
      model: options.model,
      config: {
        tools: options.tools,
        settingSources: options.settingSources,
        strictMcpConfig: options.strictMcpConfig,
        mcpServers: options.mcpServers,
        plugins: options.plugins,
        settings: options.settings,
      },
      useTool: ({
        tool,
        input,
        signal,
      }) => options.canUseTool!(
        tool,
        input,
        {
          signal: signal ?? new AbortController().signal,
          toolUseID: randomUUID(),
          requestId: randomUUID(),
        },
      ),
    }
    sessions.push(session)
    const transcript = transcriptPath({
      cwd: session.cwd,
      session: id,
      folder: session.env.CLAUDE_CONFIG_DIR,
    })
    mkdirSync(
      dirname(transcript),
      { recursive: true },
    )
    const record = ({
      role,
      text,
      uuid,
      nativeId,
    }: {
      role: string
      text: string
      uuid?: string
      nativeId?: string
    }) => appendFileSync(
      transcript,
      `${JSON.stringify({
        type: role,
        uuid: uuid ?? randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          role,
          content: role === 'assistant' ? [
            {
              type: 'text',
              text,
            },
          ] : text,
          id: nativeId,
          stop_reason: role === 'assistant' ? 'end_turn' : undefined,
        },
      })}\n`,
    )

    let contextWindow = claudeRecording.context.rawMaxTokens

    // Like the SDK, the fake reads Othrys's messages as they are sent, not one turn at a time.
    const waiting: SDKUserMessage[] = []
    const folded: {
      text: string
      uuid?: string
    }[] = []
    const foldedUuids: string[] = []
    let ended = false, folding = false
    let nudge = () => {}

    const arrived = () => {
      while (folding && waiting.length) {
        const taken = waiting.shift()!
        const text = textOf({ message: taken })
        session.received.push(text)
        session.uuids.push(taken.uuid)
        folded.push({
          text,
          uuid: taken.uuid,
        })
        foldedUuids.push(taken.uuid!)
      }

      nudge()
    }

    const reading = (async () => {
      try {
        for await (const message of prompt) {
          waiting.push(message)
          arrived()
        }
      } finally {
        ended = true
        nudge()
      }
    })()

    // Claude Code ends a stopped turn with an error result.
    const stoppedResult = ({ message }: { message: SDKUserMessage }) => ({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Request was aborted.'],
      session_id: id,
      user_message_uuids: [
        message.uuid,
        ...foldedUuids.splice(0),
      ],
      queued_turn_count: 0,
      uuid: randomUUID(),
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
    }) as unknown as SDKMessage

    async function* run(): AsyncGenerator<SDKMessage> {
      for (;;) {
        const message = waiting.shift()

        if (!message) {
          if (ended || session.closed) {
            await reading

            return
          }

          await new Promise<void>(resolve => {
            nudge = resolve
          })
          continue
        }

        const nativeId = `msg_${randomUUID()}`
        const text = textOf({ message })
        session.received.push(text)
        session.uuids.push(message.uuid)
        record({
          role: 'user',
          text,
          uuid: message.uuid,
        })
        const plan = turns.take({
          text,
          env: session.env,
        })
        const answer = plan?.reply ?? recordedReply
        folding = Boolean(plan?.folds)

        if (plan?.window !== undefined) {
          contextWindow = plan.window
        }

        arrived()
        let interrupted = false
        // A planned turn waits for its release, or for Othrys to stop it.
        const stopped = new Promise<void>(resolve => {
          stop = () => {
            interrupted = true
            resolve()
          }
        })
        const held = plan ? Promise.race([
          plan.wait,
          stopped,
        ]) : undefined

        if (plan?.compacting) {
          yield {
            type: 'system',
            subtype: 'status',
            status: 'compacting',
            uuid: randomUUID(),
            session_id: id,
          } as SDKMessage

          if (plan.compactTo === undefined) {
            await held
          }

          yield {
            type: 'system',
            subtype: 'status',
            status: null,
            compact_result: interrupted ? 'failed' : 'success',
            uuid: randomUUID(),
            session_id: id,
          } as SDKMessage
        }

        if (plan?.compacting && plan.compactTo !== undefined && !interrupted) {
          for (const matcher of options.hooks?.SessionStart ?? []) {
            for (const hook of matcher.hooks) {
              const output = await hook(
                {
                  hook_event_name: 'SessionStart',
                  source: 'compact',
                  session_id: id,
                  transcript_path: transcript,
                  cwd: session.cwd,
                },
                undefined,
                { signal: new AbortController().signal },
              )

              if ('hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'SessionStart') {
                const context = output.hookSpecificOutput.additionalContext

                if (context) {
                  session.contexts?.push(context)
                }
              }
            }
          }

          appendFileSync(
            transcript,
            `${JSON.stringify({
              type: 'system',
              subtype: 'compact_boundary',
              timestamp: new Date().toISOString(),
              compactMetadata: {
                trigger: 'manual',
                postTokens: plan.compactTo,
              },
            })}\n`,
          )
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            compact_metadata: {
              trigger: 'manual',
              pre_tokens: 0,
              post_tokens: plan.compactTo,
            },
            uuid: randomUUID(),
            session_id: id,
          } as SDKMessage
          await held

          // /compact sends no request after its boundary, so a released or stopped turn ends here, without the recorded request's usage.
          if (interrupted) {
            yield stoppedResult({ message })
          } else {
            yield {
              ...claudeRecording.turn.find(recorded => recorded.type === 'result')!,
              session_id: id,
              user_message_uuids: [message.uuid],
              queued_turn_count: 0,
              result: '',
            } as SDKMessage
          }

          stop = undefined
          session.answered = session.received.length
          continue
        }

        for (const template of claudeRecording.turn) {
          const recorded = JSON.parse(JSON.stringify(template).replaceAll(
            recordedAssistant.message.id,
            nativeId,
          )) as typeof template

          if (recorded.type === 'stream_event' && recorded.event.type === 'content_block_delta'
            && recorded.event.delta.type === 'text_delta') {
            const partial = plan?.partial ?? ''

            if (plan?.tool) {
              yield {
                ...recordedAssistant,
                session_id: id,
                uuid: randomUUID(),
                message: {
                  ...recordedAssistant.message,
                  content: [
                    {
                      type: 'tool_use' as const,
                      ...plan.tool,
                    },
                  ],
                },
              } as SDKMessage
            }

            if (partial) {
              yield {
                ...recorded,
                session_id: id,
                event: {
                  ...recorded.event,
                  delta: {
                    type: 'text_delta' as const,
                    text: partial,
                  },
                },
              }
            }

            await held

            if (interrupted) {
              break
            }

            yield {
              ...recorded,
              session_id: id,
              event: {
                ...recorded.event,
                delta: {
                  type: 'text_delta' as const,
                  text: answer.slice(partial.length),
                },
              },
            }
          } else if (recorded.type === 'assistant') {
            await held

            if (interrupted) {
              break
            }

            yield {
              ...recorded,
              session_id: id,
              message: {
                ...recorded.message,
                content: [
                  {
                    type: 'text' as const,
                    text: answer,
                    citations: null,
                  },
                ],
              },
            }

            if (plan?.splitReply) {
              const delta = claudeRecording.turn.find(event => event.type === 'stream_event'
                && event.event.type === 'content_block_delta')!
              yield {
                ...delta,
                session_id: id,
                event: {
                  type: 'content_block_start',
                  index: 1,
                  content_block: {
                    type: 'text',
                    text: '',
                  },
                },
              } as SDKMessage
              yield {
                ...delta,
                session_id: id,
                event: {
                  type: 'content_block_delta',
                  index: 1,
                  delta: {
                    type: 'text_delta',
                    text: answer,
                  },
                },
              } as SDKMessage
              yield {
                ...recorded,
                uuid: randomUUID(),
                session_id: id,
                message: {
                  ...recorded.message,
                  content: [
                    {
                      type: 'text',
                      text: answer,
                      citations: null,
                    },
                  ],
                },
              } as SDKMessage
            }
          } else if (recorded.type === 'result') {
            yield {
              ...recorded,
              session_id: id,
              user_message_uuids: [
                message.uuid,
                ...foldedUuids.splice(0),
              ],
              queued_turn_count: 0,
              result: answer,
            } as SDKMessage
          } else {
            yield {
              ...recorded,
              session_id: id,
            } as SDKMessage
          }
        }

        stop = undefined
        folding = false

        for (const input of folded.splice(0)) {
          record({
            role: 'user',
            ...input,
          })
        }

        if (interrupted) {
          yield stoppedResult({ message })
        } else {
          record({
            role: 'assistant',
            nativeId,
            text: answer,
          })

          if (plan?.splitReply) {
            record({
              role: 'assistant',
              nativeId,
              text: answer,
            })
          }
        }

        // Resumed past the last yield only when Othrys asks for more, so Othrys has read the whole turn.
        session.answered = session.received.length
      }
    }

    return Object.assign(
      run(),
      {
        close: () => {
          session.closed = true
          nudge()
        },
        // Claude Code cancels the messages it has not taken only when asked to.
        interrupt: async ({ cancelQueued }: { cancelQueued?: boolean } = {}) => {
          const queued = (cancelQueued ? waiting.splice(0) : waiting).map(message => message.uuid!)
          stop?.()

          return cancelQueued ? {
            cancelled: queued,
            still_queued: [],
          } : {
            cancelled: [],
            still_queued: queued,
          }
        },
        getContextUsage: async () => ({
          ...claudeRecording.context,
          rawMaxTokens: contextWindow,
        }),
        // eslint-disable-next-line othrys/object-params -- Claude SDK owns setting signatures.
        setModel: async (model: string) => {
          session.model = model
        },
        setPermissionMode: async () => {},
        // eslint-disable-next-line othrys/object-params -- Claude SDK owns setting signatures.
        applyFlagSettings: async (settings: { effortLevel?: string }) => {
          session.effort = settings.effortLevel
        },
      },
    )
  }) as unknown as QueryFn

  // The recording holds one request.
  const requestUsage = claudeRecording.turn.flatMap(recorded => recorded.type === 'stream_event' && recorded.event.type === 'message_start'
    ? [recorded.event.message.usage]
    : [])[0]!

  return {
    query,
    sessions,
    plan: turns.plan,
    models,
    reply: recordedReply,
    // The context the recorded turn reports: its request's input and the window Claude Code measures it against.
    context: {
      used: (requestUsage.input_tokens ?? 0) + (requestUsage.cache_creation_input_tokens ?? 0)
        + (requestUsage.cache_read_input_tokens ?? 0),
      window: claudeRecording.context.rawMaxTokens,
    },
  }
}

// An app-server in this process: each request gets its recorded result and the notifications recorded after it.
export function fakeCodex({ config = {} }: { config?: Record<string, unknown> } = {}) {
  let refuseInterrupt = false
  let reusedSession: string | undefined
  const starts = new Map<string, {
    wait: Promise<void>
    release(): void
    entered: boolean
  }>()
  const sessions: AgentSession[] = []
  const turns = plans()
  const notifications = codexRecording.session.flatMap(entry => 'notification' in entry ? [entry.notification] : [])
  const reply = notifications.filter(n => n.method === 'item/completed')
    .map(n => (n.params as { item: Message }).item)
    .filter(item => item.type === 'agentMessage')
    .map(item => String(item.text))
    .join('')
  const started = codexRecording.session.find(entry => 'method' in entry && entry.method === 'thread/start') as { result: Message }
  const recordedMessageParams = notifications.find(n => n.method === 'item/agentMessage/delta')!.params as Message
  const recordedMessage = recordedMessageParams.itemId as string
  const recordedThread = (started.result.thread as Message).id as string
  const turnStart = codexRecording.session.find(entry => 'method' in entry && entry.method === 'turn/start') as { result: Message }
  const recordedTurn = (turnStart.result.turn as Message).id as string
  const recordedUsage = notifications.find(n => n.method === 'thread/tokenUsage/updated')!
  const recordedUsageParams = recordedUsage.params as Message & {
    tokenUsage: Message & {
      last: Message & { totalTokens: number }
      modelContextWindow: number
    }
  }

  const recorded = ({ method }: { method: string }) => {
    const name = method === 'thread/resume' ? 'thread/start' : method
    const at = codexRecording.session.findIndex(entry => 'method' in entry && entry.method === name)

    if (at === -1) {
      return undefined
    }

    const end = codexRecording.session.findIndex((
      entry,
      i,
    ) => i > at && 'method' in entry)

    return {
      result: (codexRecording.session[at] as { result: Message }).result,
      notifications: codexRecording.session.slice(
        at + 1,
        end === -1 ? undefined : end,
      ).map(entry => (entry as { notification: Message }).notification),
    }
  }

  const spawnCodex: SpawnCodex = ({
    cwd,
    env,
  }) => {
    const session: AgentSession = {
      id: '',
      provider: 'codex',
      resumed: false,
      cwd,
      env,
      received: [],
      uuids: [],
      answered: 0,
      closed: false,
    }
    let transcript: string | undefined

    const record = ({
      type,
      payload,
    }: {
      type: string
      payload: Message
    }) => {
      if (transcript) {
        appendFileSync(
          transcript,
          `${JSON.stringify({
            type,
            timestamp: new Date().toISOString(),
            payload,
          })}\n`,
        )
      }
    }

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let exited = false
    let activeReplay: {
      id: string
      cancelled: boolean
    } | undefined
    const child = Object.assign(
      new EventEmitter(),
      {
        stdin,
        stdout,
        stderr,
        kill: () => {
          if (!exited) {
            exited = true
            session.closed = true
            stdout.end()
            setImmediate(() => child.emit(
              'exit',
              null,
              'SIGTERM',
            ))
          }

          return true
        },
      },
    )

    const send = ({
      message,
      turn = activeReplay?.id,
    }: {
      message: Message
      turn?: string
    }) => {
      if (!exited) {
        const threadMessage = JSON.stringify(message).replaceAll(
          recordedThread,
          session.id,
        )
        const turnMessage = turn ? threadMessage.replaceAll(
          recordedTurn,
          turn,
        ).replaceAll(
          recordedMessage,
          `${turn}:message`,
        ) : threadMessage
        stdout.write(`${turnMessage}\n`)
      }
    }

    // Codex's auto-compaction: the compaction item, then the count it reports for the compacted context.
    const compact = ({ tokens }: { tokens: number }) => {
      const item = {
        type: 'contextCompaction',
        id: randomUUID(),
      }

      for (const method of [
        'item/started',
        'item/completed',
      ]) {
        send({
          message: {
            method,
            params: {
              threadId: recordedUsageParams.threadId,
              turnId: recordedUsageParams.turnId,
              item,
            },
          },
        })
      }

      send({
        message: {
          ...recordedUsage,
          params: {
            ...recordedUsageParams,
            tokenUsage: {
              ...recordedUsageParams.tokenUsage,
              last: {
                ...recordedUsageParams.tokenUsage.last,
                totalTokens: tokens,
              },
            },
          },
        },
      })
    }

    createInterface({ input: stdin }).on(
      'line',
      async line => {
        const message = JSON.parse(line) as Message

        if (typeof message.method !== 'string' || message.id === undefined) {
          return
        }

        const params = (message.params ?? {}) as Message

        if (message.method === 'initialize' && env.OTHRYS_ACTOR) {
          const held = starts.get(env.OTHRYS_ACTOR)

          if (held) {
            starts.delete(env.OTHRYS_ACTOR)
            held.entered = true
            await held.wait
          }
        }

        if (message.method === 'config/read') {
          send({
            message: {
              id: message.id,
              result: { config },
            },
          })

          return
        }

        if (message.method === 'skills/list') {
          send({
            message: {
              id: message.id,
              result: { data: [] },
            },
          })

          return
        }

        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          session.resumed = message.method === 'thread/resume'
          session.config = params.config as Record<string, unknown> | undefined
          session.instructions = params.developerInstructions as string | undefined

          if (session.resumed) {
            session.id = String(params.threadId)
          } else if (reusedSession) {
            session.id = reusedSession
            reusedSession = undefined
          } else {
            session.id = randomUUID()
          }

          transcript = join(
            env.CODEX_HOME ?? process.env.CODEX_HOME!,
            'sessions',
            `${session.id}.jsonl`,
          )
          mkdirSync(
            dirname(transcript),
            { recursive: true },
          )
          sessions.push(session)
        }

        let plan: ReturnType<typeof turns.take>

        if (message.method === 'turn/start' || message.method === 'turn/steer') {
          const text = ((params.input ?? []) as { text?: string }[]).map(part => part.text ?? '').join('\n')
          session.received.push(text)
          plan = turns.take({
            text,
            env,
          })
        }

        const rejectedInterrupt = message.method === 'turn/interrupt' && refuseInterrupt

        if (plan?.refuse || rejectedInterrupt) {
          if (rejectedInterrupt) {
            refuseInterrupt = false
          }

          send({
            message: {
              id: message.id,
              error: {
                code: -32000,
                message: rejectedInterrupt
                  ? 'the app-server refused this interruption'
                  : plan?.refusalReason ?? 'the app-server refused this turn',
              },
            },
          })

          return
        }

        if (message.method === 'turn/interrupt') {
          if (activeReplay && activeReplay.id === params.turnId) {
            activeReplay.cancelled = true
          }

          session.answered = session.received.length
          record({
            type: 'event_msg',
            payload: { type: 'turn_aborted' },
          })
          send({
            message: {
              id: message.id,
              result: {},
            },
          })
          send({
            message: {
              method: 'turn/completed',
              params: {
                threadId: session.id,
                turn: {
                  id: params.turnId,
                  status: 'interrupted',
                  error: null,
                },
              },
            },
          })

          return
        }

        if (message.method === 'turn/steer') {
          record({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: params.input,
            },
          })
          send({
            message: {
              id: message.id,
              result: { turnId: params.expectedTurnId },
            },
          })

          return
        }

        const found = recorded({ method: message.method })

        if (!found) {
          send({
            message: {
              id: message.id,
              error: {
                code: -32601,
                message: `no recorded ${message.method}`,
              },
            },
          })

          return
        }

        const replay = message.method === 'turn/start' ? {
          id: randomUUID(),
          cancelled: false,
        } : undefined

        if (replay) {
          activeReplay = replay
          await plan?.acknowledgeStartAfter
        }

        let result = found.result

        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          result = {
            ...result,
            thread: {
              ...result.thread as Message,
              path: transcript,
              ephemeral: false,
            },
          }
        }

        if (replay) {
          record({
            type: 'event_msg',
            payload: { type: 'task_started' },
          })
          record({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: params.input,
            },
          })
        }

        send({
          message: {
            id: message.id,
            result,
          },
          turn: replay?.id,
        })

        const answer = plan?.reply ?? reply
        let sentText = false

        for (const recordedNotification of found.notifications) {
          const notificationParams = recordedNotification.params as Message
          const notificationItem = notificationParams.item as Message | undefined
          const notification = notificationItem?.type === 'agentMessage' ? {
            ...recordedNotification,
            params: {
              ...notificationParams,
              item: {
                ...notificationItem,
                text: answer,
              },
            },
          } : recordedNotification

          if (replay?.cancelled) {
            return
          }

          if (notification.method === 'item/agentMessage/delta') {
            if (sentText) {
              continue
            }

            sentText = true
            const partial = plan?.partial ?? ''

            if (partial) {
              send({
                message: {
                  ...notification,
                  params: {
                    ...notificationParams,
                    delta: partial,
                  },
                },
                turn: replay?.id,
              })
            }

            await plan?.wait

            if (replay?.cancelled) {
              return
            }

            send({
              message: {
                ...notification,
                params: {
                  ...notificationParams,
                  delta: answer.slice(partial.length),
                },
              },
              turn: replay?.id,
            })
            continue
          }

          if (notification.method === 'turn/completed') {
            await plan?.wait
          }

          if (replay?.cancelled) {
            return
          }

          if (notification.method === 'turn/completed' && plan?.compactTo !== undefined) {
            compact({ tokens: plan.compactTo })
          }

          if (notification.method === 'turn/completed') {
            record({
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                id: `${replay?.id}:message`,
                phase: 'final_answer',
                content: plan?.splitReply ? [
                  {
                    type: 'input_image',
                    image_url: 'fixture-image',
                  },
                  {
                    type: 'output_text',
                    text: answer.slice(
                      0,
                      Math.floor(answer.length / 2),
                    ),
                  },
                  {
                    type: 'input_image',
                    image_url: 'fixture-image',
                  },
                  {
                    type: 'output_text',
                    text: answer.slice(Math.floor(answer.length / 2)),
                  },
                ] : [
                  {
                    type: 'output_text',
                    text: answer,
                  },
                ],
              },
            })
            record({
              type: 'event_msg',
              payload: { type: 'task_complete' },
            })
          }

          send({
            message: notification,
            turn: replay?.id,
          })

          if (notification.method === 'turn/completed') {
            session.answered = session.received.length
          }
        }
      },
    )

    return child as unknown as ChildProcessWithoutNullStreams
  }

  return {
    spawnCodex,
    sessions,
    holdStart: ({ task }: { task: string }) => {
      const {
        promise: wait,
        resolve: release,
      } = Promise.withResolvers<void>()
      const held = {
        wait,
        release,
        entered: false,
      }
      starts.set(
        `worker:${task}`,
        held,
      )

      return {
        release,
        entered: () => held.entered,
      }
    },
    refuseNextInterrupt: () => {
      refuseInterrupt = true
    },
    reuseNextSession: ({ id }: { id: string }) => {
      reusedSession = id
    },
    plan: turns.plan,
    reply,
    // The context the recorded turn reports.
    context: {
      used: recordedUsageParams.tokenUsage.last.totalTokens,
      window: recordedUsageParams.tokenUsage.modelContextWindow,
    },
  }
}
