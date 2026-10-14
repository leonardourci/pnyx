import { cpSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { decideLink, decideNote, decidePush, type Decision } from '../src/core/decide.ts'
import type { Note } from '../src/core/model.ts'
import { loadBoard, withWriter } from '../src/store/board-store.ts'

export function seedWebFixture({ home }: { home: string }) {
  const nativePath = join(home, 'firstmate-fixture')
  cpSync(join(import.meta.dirname, 'fixtures/firstmate-home'), nativePath, { recursive: true })
  const nativeHome = realpathSync(nativePath)
  mkdirSync(join(home, 'transcripts'), { recursive: true })
  const transcript = join(home, 'transcripts/session.jsonl')
  cpSync(join(import.meta.dirname, 'fixtures/web/thread.jsonl'), transcript)
  const rows = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/web/board.json'), 'utf8')) as { key: string; [key: string]: unknown }[]
  const meta = { actor: 'fixture', at: '2026-10-13T10:50:00Z' }
  withWriter({
    board: 'default',
    fn: ({ writer: w }) => {
      const append = ({ d }: { d: Decision }) => {
        if ('event' in d) {
          w.append({ event: d.event })
        }
      }

      for (const { key, ...fields } of rows) {
        append({ d: decidePush({ state: w.state, key, input: { ...fields, ...(key === 'layout' ? { source: { adapter: 'firstmate', instanceId: nativeHome, objectId: 'api-v2' }, agent: { provider: 'claude', sessionId: 'fixture-layout', transcriptPath: transcript } } : {}) }, meta }) })
      }

      for (const [key, number, state] of [['layout', 42, 'open'], ['review', 321, 'open'], ['docs', 309, 'merged']] as const) {
        const url = `https://github.com/example/project/pull/${number}`; append({ d: decideLink({ state: w.state, ref: key, url, link: { kind: 'github_pr', url, number, state }, meta }) })
      }

      const notes = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/web/notes.json'), 'utf8')) as Note[]
      notes.forEach((note, i) => append({ d: decideNote({ state: w.state, ref: 'layout', note, meta: { ...meta, id: `fixture-note-${i}` } }) }))

      const url = 'https://linear.app/example/issue/UI-42'
      append({ d: decideLink({ state: w.state, ref: 'layout', url, link: { kind: 'linear', url, title: 'Design the agent board' }, meta }) })
    },
  })

  return { nativeHome, transcript, state: loadBoard({ board: 'default' }).state }
}
