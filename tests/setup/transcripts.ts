import { appendFileSync } from 'node:fs'
import { transcriptPath } from '#workers/claude.ts'
import type { AgentSession } from './agents.ts'

// Appends records to a Claude session's transcript, one millisecond apart, and waits out their timestamps so the next
// message sorts after them.
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
  let time = Date.now()
  const lines = records.map(record => JSON.stringify({
    type: record.type,
    timestamp: new Date(time += 1).toISOString(),
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
  await new Promise(resolve => setTimeout(
    resolve,
    time - Date.now() + 1,
  ))
}

// Appends a long working stretch to a Claude session's transcript.
export async function appendToolCalls({
  session,
  tools,
}: {
  session: AgentSession
  tools: number
}) {
  await appendRecords({
    session,
    records: Array.from(
      { length: tools },
      (
        _,
        tool,
      ) => tool,
    ).flatMap(tool => [
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
