import { appendFileSync, existsSync } from 'node:fs'
import { until } from '../scenarios/harness.ts'

export async function budgetProbe({
  events,
  gate,
  lane,
}: {
  events: string
  gate: string
  lane: string
}) {
  const record = ({ phase }: { phase: string }) => appendFileSync(
    events,
    `${JSON.stringify({
      phase,
      pid: process.pid,
      gate,
      lane,
      directories: Object.fromEntries([
        'HOME',
        'PNYX_HOME',
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'TMPDIR',
      ].map(key => [
        key,
        process.env[key],
      ])),
    })}\n`,
  )
  record({ phase: 'start' })

  try {
    await until({
      what: 'the launcher budget gate to open',
      check: () => existsSync(gate),
    })
  } finally {
    record({ phase: 'end' })
  }
}
