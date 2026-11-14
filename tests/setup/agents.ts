// Fake Claude Code and Codex replaying a real recorded turn (`pnpm refresh-agent-fixtures`), so Pnyx's provider code runs as in use.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { ModelInfo, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
  turn: SDKMessage[]
}>({ name: 'claude.json' })
const codexRecording = recording<{
  session: ({
    method: string
    result: Message
  } | { notification: Message })[]
}>({ name: 'codex.json' })

// One agent session as Pnyx started it, and everything it heard.
export interface AgentSession {
  id: string
  provider: 'claude' | 'codex'
  resumed: boolean
  cwd: string
  env: NodeJS.ProcessEnv
  received: string[]
  // Received messages whose turn ended.
  answered: number
  closed: boolean
  model?: string
  // Codex: the config Pnyx opened the thread with.
  config?: Record<string, unknown>
  // Claude: the agent calls a tool that needs permission mid-turn and gets Pnyx's decision.
  useTool?({
    tool,
    input,
  }: {
    tool: string
    input: Record<string, unknown>
  }): Promise<PermissionResult | null>
}

export interface TurnPlan {
  // The next prompt ending with this text, or the one match accepts, takes the plan.
  text?: string
  match?({ text }: { text: string }): boolean
  reply?: string
  // Streams this prefix of the reply, then waits for release (or an interrupt) before finishing the turn.
  partial?: string
  hold?: boolean
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
      const at = waiting.findIndex(plan => (!plan.hydra || plan.hydra === env.PNYX_HYDRA)
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

export function fakeClaude() {
  const sessions: AgentSession[] = []
  const turns = plans()
  const recordedReply = claudeRecording.turn.flatMap(m => m.type === 'assistant'
    ? m.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : []).join('')

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
        supportedModels: async () => claudeRecording.models,
        close: () => {},
      }
    }

    // Without its own environment an agent's pnyx-axi would reach the owner's real Pnyx.
    if (!options.env?.PNYX_HOME) {
      throw new Error('a fake agent started without its own PNYX_HOME')
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
      answered: 0,
      closed: false,
      model: options.model,
      useTool: ({
        tool,
        input,
      }) => options.canUseTool!(
        tool,
        input,
        {
          signal: new AbortController().signal,
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
    }: {
      role: string
      text: string
    }) => appendFileSync(
      transcript,
      `${JSON.stringify({
        type: role,
        timestamp: new Date().toISOString(),
        message: {
          role,
          content: text,
        },
      })}\n`,
    )

    async function* run(): AsyncGenerator<SDKMessage> {
      for await (const message of prompt) {
        const text = textOf({ message })
        session.received.push(text)
        record({
          role: 'user',
          text,
        })
        const plan = turns.take({
          text,
          env: session.env,
        })
        const answer = plan?.reply ?? recordedReply
        let interrupted = false
        // A planned turn waits for its release, or for Pnyx to stop it.
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

        for (const recorded of claudeRecording.turn) {
          if (recorded.type === 'stream_event' && recorded.event.type === 'content_block_delta'
            && recorded.event.delta.type === 'text_delta') {
            const partial = plan?.partial ?? ''

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
          } else if (recorded.type === 'result') {
            yield {
              ...recorded,
              session_id: id,
              user_message_uuid: message.uuid,
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

        if (interrupted) {
          // Claude Code ends a stopped turn with an error result.
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['Request was aborted.'],
            session_id: id,
            user_message_uuid: message.uuid,
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
          } as unknown as SDKMessage
        } else {
          record({
            role: 'assistant',
            text: answer,
          })
        }

        // Resumed past the last yield only when Pnyx asks for more, so Pnyx has read the whole turn.
        session.answered = session.received.length
      }
    }

    return Object.assign(
      run(),
      {
        close: () => {
          session.closed = true
        },
        interrupt: async () => {
          stop?.()
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
        applyFlagSettings: async () => {},
      },
    )
  }) as unknown as QueryFn

  return {
    query,
    sessions,
    plan: turns.plan,
    reply: recordedReply,
  }
}

// An app-server in this process: each request gets its recorded result and the notifications recorded after it.
export function fakeCodex() {
  const sessions: AgentSession[] = []
  const turns = plans()
  const notifications = codexRecording.session.flatMap(entry => 'notification' in entry ? [entry.notification] : [])
  const reply = notifications.filter(n => n.method === 'item/completed')
    .map(n => (n.params as { item: Message }).item)
    .filter(item => item.type === 'agentMessage')
    .map(item => String(item.text))
    .join('')
  const started = codexRecording.session.find(entry => 'method' in entry && entry.method === 'thread/start') as { result: Message }
  const recordedThread = (started.result.thread as Message).id as string

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
      answered: 0,
      closed: false,
    }
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let exited = false
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

    const send = ({ message }: { message: Message }) => {
      if (!exited) {
        stdout.write(`${JSON.stringify(message).replaceAll(
          recordedThread,
          session.id,
        )}\n`)
      }
    }

    createInterface({ input: stdin }).on(
      'line',
      async line => {
        const message = JSON.parse(line) as Message

        if (typeof message.method !== 'string' || message.id === undefined) {
          return
        }

        const params = (message.params ?? {}) as Message

        if (message.method === 'config/read') {
          send({
            message: {
              id: message.id,
              result: { config: {} },
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
          session.id = session.resumed ? String(params.threadId) : randomUUID()
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

        if (message.method === 'turn/steer') {
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

        send({
          message: {
            id: message.id,
            result: found.result,
          },
        })

        for (const notification of found.notifications) {
          if (notification.method === 'item/agentMessage/delta' || notification.method === 'turn/completed') {
            await plan?.wait
          }

          send({ message: notification })

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
    plan: turns.plan,
    reply,
  }
}
