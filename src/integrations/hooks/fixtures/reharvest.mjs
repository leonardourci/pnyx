import { withWriter } from '#app/writer.ts'
import { harvestTranscripts } from '#integrations/hooks/harvest.ts'

withWriter({
  hydraId: 'default',
  fn: ({ writer }) => harvestTranscripts({
    writer,
    cardIds: ['$hydra'],
    at: '2026-10-22T10:00:05Z',
    detached: {
      task: '$hydra',
      memberships: [],
      session: {
        id: 'claude-code:fixture',
        originCardId: '$hydra',
        taskId: '$hydra',
        attention: [],
        sourceRefs: [],
        agent: {
          provider: 'claude-code',
          sessionId: 'fixture',
          transcriptPath: process.argv[2],
        },
      },
    },
  }),
})
