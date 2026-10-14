// Delivers a reply or decision answer to a Firstmate task through the home's own
// send command, `bin/fm-send.sh <task> [--resolve-key <key>] <text>`, and a setting
// change for its worker to the orchestrator as a request note through the home's
// `bin/fm-inbox.sh`, each run with an explicit FM_HOME. The receipts around them are
// written by `pnyx-axi reply` and `pnyx-axi agent`.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { ReplyState } from '../../core/model.ts'

const SEND_TIMEOUT_MS = 120_000
const DETAIL_MAX = 300

type Sent = { state: ReplyState; detail?: string }

// fm-send's exit contract as read here: 0 delivered; 1 and 3 may have landed (a
// remote send that lost its transport exits 1); any other status nothing delivered.
export function fmSend(
  route: { home: string; task: string },
  text: string,
  resolveKey: string | undefined,
): Sent {
  const args = [route.task, ...(resolveKey ? ['--resolve-key', resolveKey] : []), text]
  const result = run({ home: route.home, command: 'fm-send.sh', args })
  const detail = result.detail ? { detail: result.detail } : {}

  if (result.error) {
    return { state: 'failed', detail: result.error }
  }

  if (result.status === 0) {
    return { state: 'delivered' }
  }

  // Killed by the timeout or a signal, or sent without confirmation: the message
  // may have landed, so it must not be resent blindly.
  if (result.status === null || result.status === 1 || result.status === 3) {
    return { state: 'delivery_unknown', ...detail }
  }

  return { state: 'failed', ...detail }
}

function run({ home, command, args }: { home: string; command: string; args: string[] }) {
  const result = spawnSync(join(home, 'bin', command), args, {
    env: { ...process.env, FM_HOME: home },
    encoding: 'utf8',
    timeout: SEND_TIMEOUT_MS,
  })
  const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n')
    .at(-1)
    ?.slice(0, DETAIL_MAX)
  const error = result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT'
    ? `cannot run ${command}: ${result.error.message}`
    : undefined

  return { status: result.status, stdout: result.stdout ?? '', detail, error }
}

// Asks the orchestrator for a change to the task's worker with a request note,
// `fm-inbox.sh note --request-id <id> --json -- <text>`. The same request id replays
// the note it saved first. Its exit contract: 0 saved and announced; 3 saved but not
// announced, which `fm-inbox.sh announce <note>` repairs; 1 nothing saved.
export function fmNote({ home, requestId, text }: {
  home: string
  requestId: string
  text: string
}): Sent {
  const result = run({ home, command: 'fm-inbox.sh', args: ['note', '--request-id', requestId, '--json', '--', text] })
  const detail = result.detail ? { detail: result.detail } : {}

  if (result.error) {
    return { state: 'failed', detail: result.error }
  }

  let note: string | undefined

  try {
    const id = (JSON.parse(result.stdout.trim().split('\n')
      .at(-1) ?? '') as { id?: unknown }).id
    note = typeof id === 'string' ? id : undefined
  } catch {
    note = undefined
  }

  if (result.status === 0 && note) {
    return { state: 'delivered', detail: `Firstmate note ${note}` }
  }

  if (result.status === 3 && note) {
    return { state: 'delivery_unknown', detail: `Firstmate saved note ${note} but did not announce it; run FM_HOME=${home} ${join(home, 'bin', 'fm-inbox.sh')} announce ${note}` }
  }

  return result.status === 1 ? { state: 'failed', ...detail } : { state: 'delivery_unknown', ...detail }
}

export type NoteState = 'queued' | 'handled' | 'replied'

export interface NoteReceipt { note: string; requestId: string; state: NoteState; asked: string }

// The home's request notes whose request id starts with prefix, from the read-only
// `fm-inbox.sh receipts`: a pending note is queued, an acknowledged one handled, and
// one with a recorded reply replied. Undefined when the receipts cannot be read.
export function fmReceipts({ home, prefix }: {
  home: string
  prefix: string
}): NoteReceipt[] | undefined {
  const result = run({ home, command: 'fm-inbox.sh', args: ['receipts'] })

  if (result.error || result.status !== 0) {
    return undefined
  }

  type Row = {
    id?: unknown
    request_id?: unknown
    body?: unknown
    acknowledged?: unknown
    reply?: unknown
  }

  try {
    const { pending, handled } = JSON.parse(result.stdout) as { pending?: Row[]; handled?: Row[] }

    return [...(pending ?? []), ...(handled ?? [])].flatMap(r =>
      typeof r.id === 'string' && typeof r.request_id === 'string' && r.request_id.startsWith(prefix)
        ? [{
          note: r.id,
          requestId: r.request_id,
          state: r.reply ? 'replied' as const : r.acknowledged === true ? 'handled' as const : 'queued' as const,
          asked: typeof r.body === 'string' ? r.body : '',
        }]
        : [])
  } catch {
    return undefined
  }
}
