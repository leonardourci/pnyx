// Fake Claude Code and Codex that replay the real sessions recorded in src/test-harness/recordings/
// (`pnpm refresh-agent-fixtures`), so flows run Pnyx's own provider code over real agent output.
import assert from 'node:assert/strict'
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

const FIXTURES = join(
  import.meta.dirname,
  'recordings',
)

const recording = <T>({ name }: { name: string }) => JSON.parse(readFileSync(
  join(
    FIXTURES,
    name,
  ),
  'utf8',
)) as T

export const claudeRecording = recording<{
  sdk: string
  claude: string
  models: ModelInfo[]
  turn: SDKMessage[]
}>({ name: 'claude.json' })

type Message = Record<string, unknown>

export const codexRecording = recording<{
  codex: string
  protocol: Record<'clientRequests' | 'serverRequests' | 'serverNotifications', string[]>
  // In order: each request Pnyx's side sent with its result, and the notifications Codex sent after it.
  session: ({
    method: string
    result: Message
  } | { notification: Message })[]
}>({ name: 'codex.json' })

// What one agent session was started with and every message it received, in order.
export interface AgentSession {
  // The Claude session or Codex thread.
  id: string
  resumed: boolean
  cwd: string
  env: NodeJS.ProcessEnv
  received: string[]
  // Received messages whose turn ended: for Claude once Pnyx has read the turn's last message, for Codex once turn/completed is written.
  answered?: number
  model?: string
  // Codex only: the method of each request Pnyx sent.
  requests?: string[]
  // Claude only: the agent calls a tool that needs permission, as Claude Code does mid-turn, and gets Pnyx's decision.
  useTool?({
    tool,
    input,
  }: {
    tool: string
    input: Record<string, unknown>
  }): Promise<PermissionResult | null>
  // Codex only: the agent sends this request mid-turn, as Codex asks for an approval, and gets Pnyx's answer.
  ask?({
    method,
    params,
  }: {
    method: string
    params: Message
  }): Promise<unknown>
}

const textOf = ({ message }: { message: SDKUserMessage }) => {
  const { content } = message.message

  return typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

interface TurnPlan {
  text: string
  reply?: string
  hold?: boolean
}

function plannedTurns() {
  const plans: (TurnPlan & {
    wait: Promise<void>
  })[] = []

  return {
    plan: ({
      text,
      reply,
      hold,
    }: TurnPlan) => {
      let release = () => {}
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      plans.push({
        text,
        reply,
        hold,
        wait,
      })

      if (!hold) {
        release()
      }

      return { release }
    },
    take: ({ text }: { text: string }) => {
      const index = plans.findIndex(plan => text.endsWith(plan.text))

      if (index >= 0) {
        return plans.splice(
          index,
          1,
        )[0]
      }
    },
  }
}

// Each message starts the recorded turn again under the session's own id; the transcript is written as Claude Code writes it.
export function replayClaude() {
  const sessions: AgentSession[] = []
  const turns = plannedTurns()
  const reply = claudeRecording.turn.flatMap(m => m.type === 'assistant'
    ? m.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : []).join('')

  const query = (({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }) => {
    // A catalog read opens no session.
    if (options.persistSession === false) {
      return {
        supportedModels: async () => claudeRecording.models,
        close: () => {},
      }
    }

    // Without its own environment an agent's commands would reach the owner's real Pnyx.
    assert.ok(options.env)
    const id = options.sessionId ?? options.resume!
    const session: AgentSession = {
      id,
      resumed: Boolean(options.resume),
      cwd: options.cwd!,
      env: options.env,
      received: [],
      answered: 0,
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
    const path = transcriptPath({
      cwd: session.cwd,
      session: id,
      folder: session.env.CLAUDE_CONFIG_DIR,
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
      `${JSON.stringify({
        type: role,
        timestamp: new Date().toISOString(),
        message: {
          role,
          content: text,
        },
      })}\n`,
    )

    async function* run() {
      for await (const message of prompt) {
        const text = textOf({ message })
        session.received.push(text)
        record({
          role: 'user',
          text,
        })

        const plan = turns.take({ text })
        const answer = plan?.reply ?? reply

        for (const recorded of claudeRecording.turn) {
          if (recorded.type === 'assistant') {
            await plan?.wait
            yield {
              ...recorded,
              session_id: id,
              message: {
                ...recorded.message,
                content: [
                  {
                    type: 'text',
                    text: answer,
                  },
                ],
              },
            }
          } else if (recorded.type === 'stream_event' && recorded.event.type === 'content_block_delta'
            && recorded.event.delta.type === 'text_delta') {
            yield {
              ...recorded,
              session_id: id,
              event: {
                ...recorded.event,
                delta: {
                  type: 'text_delta',
                  text: answer,
                },
              },
            }
          } else {
            yield {
              ...recorded,
              session_id: id,
            }
          }
        }

        // The loop above resumes past the last yield only when Pnyx asks for more, so Pnyx has read the whole turn.
        session.answered = session.received.length
        record({
          role: 'assistant',
          text: answer,
        })
      }
    }

    return Object.assign(
      run(),
      {
        close: () => {},
        interrupt: async () => {},
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
    reply,
  }
}

// An app-server in this process: each request gets its recorded result, followed by the notifications
// recorded after it, under the session's own thread id. thread/resume answers as thread/start did.
export function replayCodex() {
  const sessions: AgentSession[] = []
  const turns = plannedTurns()
  // refuse: a method answered with an error while set, as a harness that cannot open a thread; refused counts them.
  const control = {
    refuse: undefined as string | undefined,
    refused: 0,
  }
  const notifications = codexRecording.session.flatMap(entry => 'notification' in entry ? [entry.notification] : [])
  const reply = notifications
    .filter(n => n.method === 'item/completed')
    .map(n => (n.params as { item: Message }).item)
    .filter(item => item.type === 'agentMessage')
    .map(item => String(item.text))
    .join('')
  const started = codexRecording.session.find(entry => 'method' in entry && entry.method === 'thread/start')
  const recordedThread = ((started as { result: Message }).result.thread as Message).id as string

  const answer = ({ method }: { method: string }) => {
    const recordedMethod = method === 'thread/resume' ? 'thread/start' : method
    const at = codexRecording.session.findIndex(entry => 'method' in entry && entry.method === recordedMethod)

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
      resumed: false,
      cwd,
      env,
      received: [],
      answered: 0,
      requests: [],
      ask: ({
        method,
        params,
      }) => new Promise(resolve => {
        const id = `ask-${randomUUID()}`
        answers.once(
          id,
          resolve,
        )
        send({
          message: {
            id,
            method,
            params: {
              threadId: session.id,
              turnId: id,
              ...params,
            },
          },
        })
      }),
    }
    const answers = new EventEmitter()
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

        if (message.method === undefined && answers.emit(
          String(message.id),
          message.result ?? message.error,
        )) {
          return
        }

        if (typeof message.method !== 'string' || message.id === undefined) {
          return
        }

        session.requests!.push(message.method)

        if (message.method === control.refuse) {
          control.refused += 1
          send({
            message: {
              id: message.id,
              error: {
                code: -32000,
                message: `refused ${message.method}`,
              },
            },
          })

          return
        }

        // A model or config read is not a session; one that opens a thread is.
        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          session.resumed = message.method === 'thread/resume'
          const { threadId } = message.params as { threadId?: string }
          session.id = session.resumed ? threadId! : randomUUID()
          sessions.push(session)
        }

        let plan: ReturnType<typeof turns.take>

        if (message.method === 'turn/start' || message.method === 'turn/steer') {
          const input = (message.params as { input?: { text?: string }[] }).input ?? []
          const text = input.map(part => part.text ?? '').join('\n')
          session.received.push(text)
          plan = turns.take({ text })
        }

        if (message.method === 'turn/steer') {
          send({
            message: {
              id: message.id,
              result: { turnId: (message.params as { expectedTurnId: string }).expectedTurnId },
            },
          })

          return
        }

        const found = answer({ method: message.method })

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

        try {
          for (const notification of found.notifications) {
            if (notification.method === 'turn/completed' || notification.method === 'item/agentMessage/delta') {
              await plan?.wait
            }

            send({ message: notification })

            if (notification.method === 'turn/completed') {
              session.answered = session.received.length
            }
          }
        } catch (error) {
          child.emit(
            'error',
            error,
          )
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
    control,
  }
}
