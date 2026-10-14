// Delivers a reply or decision answer to a Firstmate task through the home's own
// send command, `bin/fm-send.sh <task> [--resolve-key <key>] <text>`, run with an
// explicit FM_HOME. The receipts around it are written by `pnyx-axi reply`.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { ReplyState } from '../../core/model.ts'

const SEND_TIMEOUT_MS = 120_000
const DETAIL_MAX = 300

// fm-send's exit contract as read here: 0 delivered; 1 and 3 may have landed (a
// remote send that lost its transport exits 1); any other status nothing delivered.
export function fmSend(
  { route, text, resolveKey } : {
    route: {
      home: string
      task: string
    }
    text: string
    resolveKey: string | undefined
  },
): { state: ReplyState; detail?: string } {
  const args = [route.task, ...(resolveKey ? ['--resolve-key', resolveKey] : []), text]
  const result = spawnSync(join(route.home, 'bin', 'fm-send.sh'), args, {
    env: { ...process.env, FM_HOME: route.home },
    encoding: 'utf8',
    timeout: SEND_TIMEOUT_MS,
  })
  const lastLine = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n')
    .at(-1)
    ?.slice(0, DETAIL_MAX)
  const detail = lastLine ? { detail: lastLine } : {}

  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    return { state: 'failed', detail: `cannot run fm-send.sh: ${result.error.message}` }
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
