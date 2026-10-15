import { execFileSync } from 'node:child_process'
import { uptime } from 'node:os'
import type { AgentSession, BoardState } from '../../core/model.ts'
import { liveTask } from '../../core/tasks.ts'
import { localPaseoUrl } from '../../core/paseo.ts'
import { openPaseo, type Connect } from '../paseo/client.ts'

export type Presence = { state: 'present' | 'gone' | 'unknown'; detail: string }

export function terminalPresence({ session, verifyProcess = false, bootedAt = Date.now() - uptime() * 1000, run = ({ pid }) => execFileSync('ps', ['-o', 'tty=', '-p', pid], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }) }: {
  session: AgentSession
  verifyProcess?: boolean
  bootedAt?: number
  run?({ pid }: { pid: string }): string
}): Presence {
  const ended = session.activity === 'ended' || session.sessionActivity === 'ended'

  if (ended && (!verifyProcess || !session.terminal?.pid)) {
    return { state: 'gone', detail: 'The harness recorded the session ending.' }
  }

  if (session.lastSeen && Date.parse(session.lastSeen) < bootedAt - 2000) {
    return { state: 'gone', detail: 'Last observed before this machine started.' }
  }

  const { pid, tty } = session.terminal ?? {}

  if (!pid || !tty) {
    return { state: 'unknown', detail: 'No process and terminal were recorded.' }
  }

  try {
    const current = run({ pid }).trim()

    return current && `/dev/${current}` === tty
      ? { state: 'present', detail: 'The recorded process still owns its terminal.' }
      : { state: 'gone', detail: 'The recorded process no longer owns its terminal.' }
  } catch (error) {
    return (error as { status?: number }).status === 1
      ? { state: 'gone', detail: 'The recorded process has exited.' }
      : { state: 'unknown', detail: 'The process could not be checked.' }
  }
}

export async function checkAttachments({ state, connect = openPaseo, probe = terminalPresence }: {
  state: BoardState
  connect?: Connect
  probe?({ session }: { session: AgentSession }): Presence
}) {
  const sessions = Object.values(state.sessions ?? {})
    .filter(s => (s.taskId && state.cards[s.taskId] && liveTask({ card: state.cards[s.taskId] }))
      || state.board?.hydra.session === s.id)
  const endpoints = new Map<string, Promise<Map<string, Presence>>>()

  const paseo = ({ url }: { url: string }) => {
    let result = endpoints.get(url)

    if (!result) {
      result = (async () => {
        const client = await connect({ url: localPaseoUrl({ url }) })

        try {
          const attached = sessions.filter(s => s.agent.paseoUrl === url && s.agent.paseoAgentId)
          const rows = await Promise.all(attached.map(async s => {
            const current = await client.agents.ref(s.agent.paseoAgentId!).refresh()

            return [s.id, current && !current.agent.archivedAt
              ? { state: 'present' as const, detail: 'Paseo still has this agent session.' }
              : { state: 'gone' as const, detail: 'Paseo no longer has this agent session.' }] as const
          }))

          return new Map<string, Presence>(rows)
        } finally {
          await client.close().catch(() => undefined)
        }
      })()
      endpoints.set(url, result)
    }

    return result
  }

  return Promise.all(sessions.map(async session => {
    let presence: Presence

    if (session.agent.host === 'pnyx') {
      presence = { state: 'present', detail: 'Pnyx runs this agent; its next message resumes the session.' }
    } else if (session.agent.paseoUrl && session.agent.paseoAgentId) {
      try {
        presence = (await paseo({ url: session.agent.paseoUrl })).get(session.id) ?? { state: 'unknown', detail: 'Paseo did not answer for this agent.' }
      } catch {
        presence = { state: 'unknown', detail: 'Paseo is unreachable; the agent may still exist.' }
      }
    } else {
      presence = probe({ session })
    }

    return { task: session.taskId ?? '$hydra', session: session.id, harness: session.agent.provider, folder: session.agent.cwd ?? session.launch?.folder ?? 'unknown', via: session.launch?.via ?? 'unknown', started: session.launch?.at ?? 'unknown', lastSeen: session.lastSeen ?? 'unknown', ...presence }
  }))
}
