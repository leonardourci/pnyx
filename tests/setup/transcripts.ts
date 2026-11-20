import { appendFileSync } from 'node:fs'
import { transcriptPath } from '#workers/claude.ts'
import type { AgentSession } from './agents.ts'

const clockPast = ({ time }: { time: number }) => new Promise(resolve => setTimeout(
  resolve,
  time - Date.now() + 1,
))

export async function appendRecords({
  session,
  records,
}: {
  session: AgentSession
  records: {
    type: 'assistant' | 'user'
    content: unknown
  }[]
}) {
  const start = Date.now()
  const lines = records.map((
    record,
    index,
  ) => JSON.stringify({
    type: record.type,
    timestamp: new Date(start + index + 1).toISOString(),
    message: {
      role: record.type,
      content: record.content,
    },
  }))
  appendFileSync(
    transcriptPath({
      cwd: session.cwd,
      session: session.id,
      folder: session.env.CLAUDE_CONFIG_DIR,
    }),
    `${lines.join('\n')}\n`,
  )
  await clockPast({ time: start + records.length })
}

export async function appendToolCalls({
  session,
  tools,
}: {
  session: AgentSession
  tools: number
}) {
  await appendRecords({
    session,
    records: Array.from({ length: tools }).flatMap((
      _,
      tool,
    ) => [
      {
        type: 'assistant' as const,
        content: [
          {
            type: 'tool_use',
            id: `toolu_${tool}`,
            name: 'Bash',
            input: { command: `echo ${tool}` },
          },
        ],
      },
      {
        type: 'user' as const,
        content: [
          {
            type: 'tool_result',
            tool_use_id: `toolu_${tool}`,
            content: 'ok',
          },
        ],
      },
    ]),
  })
}
