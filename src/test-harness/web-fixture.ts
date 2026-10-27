import { cpSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { decideLink, decideNote, decidePush, decideView, type Decision } from '../core/decide.ts'
import { hydraEvent } from '../core/hydra.ts'
import type { Note } from '../core/model.ts'
import { withWriter } from '../app/writer.ts'
import { loadHydra } from '../app/store.ts'

export function seedWebFixture({ home }: { home: string }) {
  const nativePath = join(
    home,
    'firstmate-fixture',
  )
  cpSync(
    join(
      import.meta.dirname,
      '../../test/fixtures/firstmate-home',
    ),
    nativePath,
    { recursive: true },
  )
  const nativeHome = realpathSync(nativePath)
  mkdirSync(
    join(
      home,
      'transcripts',
    ),
    { recursive: true },
  )
  const transcript = join(
    home,
    'transcripts/session.jsonl',
  )
  cpSync(
    join(
      import.meta.dirname,
      '../../test/fixtures/web/thread.jsonl',
    ),
    transcript,
  )
  const rows = JSON.parse(readFileSync(
    join(
      import.meta.dirname,
      '../../test/fixtures/web/hydra.json',
    ),
    'utf8',
  )) as {
    key: string
    [key: string]: unknown
  }[]
  const meta = {
    actor: 'fixture',
    at: new Date().toISOString(),
  }
  withWriter({
    hydraId: 'default',
    fn: ({ writer: w }) => {
      const append = ({ d }: { d: Decision }) => {
        if ('event' in d) {
          w.append({ event: d.event })
        }
      }

      for (const {
        key,
        ...fields
      } of rows) {
        const column = key === 'layout' || key === 'coverage' ? 'needs_you'
          : key === 'review' ? 'parked' : key === 'docs' ? 'done' : 'in_progress'
        const parentId = typeof fields.parent === 'string' ? w.state.keys[fields.parent] : undefined
        append({
          d: hydraEvent({
            state: w.state,
            meta,
            cardId: `c${w.state.seq + 1}`,
            change: {
              type: 'task.created',
              data: {
                key,
                title: String(fields.title),
                column,
                ...(parentId ? { parentId } : {}),
              },
            },
          }),
        })
        append({
          d: decidePush({
            state: w.state,
            newCardId: `c${w.state.seq + 1}`,
            key,
            input: {
              ...fields,
              ...(key === 'layout' ? {
                source: {
                  adapter: 'firstmate',
                  instanceId: nativeHome,
                  objectId: 'api-v2',
                },
                agent: {
                  provider: 'claude-code',
                  sessionId: 'fixture-layout',
                  transcriptPath: transcript,
                },
              } : {}),
            },
            meta,
          }),
        })
      }

      for (const [
        key,
        number,
        state,
      ] of [
          [
            'layout',
            42,
            'open',
          ],
          [
            'review',
            321,
            'open',
          ],
          [
            'docs',
            309,
            'merged',
          ],
        ] as const) {
        const url = `https://github.com/example/project/pull/${number}`; append({
          d: decideLink({
            state: w.state,
            ref: key,
            url,
            // What the fake gh-axi reports, so following these pull requests records nothing new.
            link: {
              kind: 'github_pr',
              url,
              number,
              state,
              draft: false,
              checks: '0 passed, 0 failed',
              comments: 0,
            },
            meta,
          }),
        })
      }

      const notes = JSON.parse(readFileSync(
        join(
          import.meta.dirname,
          '../../test/fixtures/web/notes.json',
        ),
        'utf8',
      )) as Note[]
      notes.forEach((
        note,
        i,
      ) => append({
        d: decideNote({
          state: w.state,
          ref: 'layout',
          note,
          meta: {
            ...meta,
            id: `fixture-note-${i}`,
          },
        }),
      }))

      const url = 'https://linear.app/example/issue/UI-42'
      append({
        d: decideLink({
          state: w.state,
          ref: 'layout',
          url,
          link: {
            kind: 'linear',
            url,
            title: 'Design the agent Hydra',
          },
          meta,
        }),
      })
      append({
        d: decideView({
          state: w.state,
          patch: { panelPlacement: 'right' },
          meta,
        }),
      })
    },
  })

  return {
    nativeHome,
    transcript,
    state: loadHydra({ hydraId: 'default' }).state,
  }
}
