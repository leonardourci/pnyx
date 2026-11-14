import { appendFileSync } from 'node:fs'
import { transcriptPath } from '#workers/claude.ts'
import type { AgentSession } from './agents.ts'

// Appends a long working stretch to a Claude session's transcript, and waits out its timestamps so the next message sorts after it.
export async function appendToolCalls({
  session,
  tools,
}: {
  session: AgentSession
  tools: number
}) {
  const lines: string[] = []
  let time = Date.now()
  const stamp = () => new Date(time += 1).toISOString()

  for (let tool = 0; tool < tools; tool++) {
    const id = `toolu_${tool}`
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: stamp(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id,
              name: 'Bash',
              input: { command: `echo ${tool}` },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: stamp(),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: 'ok',
            },
          ],
        },
      }),
    )
  }

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
