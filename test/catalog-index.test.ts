import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCatalogIndex } from '../src/thread/catalog-index.ts'
import { readCatalog } from '../src/thread/catalog.ts'
import { decidePush } from '../src/core/decide.ts'
import { emptyHydra, reduce } from '../src/core/reducer.ts'

const pause = () => new Promise(resolve => setTimeout(
  resolve,
  30,
))

for (const statOnly of [
  false,
  true,
]) {
  test(
    `catalog index follows edits and serves cached menus (${statOnly ? 'stat recovery' : 'file events'})`,
    async t => {
      if (statOnly) {
        t.mock.method(
          fs,
          'watch',
          () => Object.assign(
            new EventEmitter(),
            {
              close() {},
              unref() {},
            },
          ),
        )
        syncBuiltinESMExports()
        t.after(() => {
          t.mock.restoreAll(); syncBuiltinESMExports()
        })
      }

      const root = mkdtempSync(join(
        tmpdir(),
        'pnyx-catalog-index-',
      ))
      const cwd = join(
        root,
        'agent',
      )
      mkdirSync(cwd)
      const decision = decidePush({
        state: emptyHydra(),
        newCardId: 'c1',
        key: 'test',
        input: {
          agent: {
            provider: 'codex',
            sessionId: 'fixture',
            cwd,
          },
        },
        meta: {
          actor: 'test',
          at: '2026-10-23T10:00:00Z',
        },
      })
      assert.ok('event' in decision)
      const card = reduce({
        state: emptyHydra(),
        event: decision.event,
      }).cards.c1!
      let scans = 0
      const index = createCatalogIndex({
        locations: {
          home: root,
          claude: join(
            root,
            'claude',
          ),
          codex: join(
            root,
            'codex',
          ),
        },
        scan: async ({
          card,
          projects,
          locations,
          observe,
        }) => {
          scans++

          return readCatalog({
            card,
            projects,
            locations,
            observe,
          })
        },
      })
      t.after(() => {
        index.close(); rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      })
      assert.deepEqual(
        (await index.read({ card })).suggestions,
        [],
      )
      const count = scans

      for (let n = 0; n < 20; n++) {
        await index.read({ card })
      }

      assert.equal(
        scans,
        count,
        'opening cached menus must not rescan skills',
      )
      const path = join(
        cwd,
        '.agents/skills/review/SKILL.md',
      )
      mkdirSync(
        join(
          cwd,
          '.agents/skills/review',
        ),
        { recursive: true },
      )
      const write = ({ description }: { description: string }) => writeFileSync(
        path,
        `---\nname: review\ndescription: ${description}\n---\n`,
      )

      const until = async ({ description }: { description?: string }) => {
        const deadline = Date.now() + 5000

        do {
          const suggestions = (await index.read({ card })).suggestions

          const ready = description
            ? suggestions.some(item => item.description === description)
            : suggestions.length === 0

          if (ready) {
            return
          }

          await pause()
        } while (Date.now() < deadline)

        assert.fail(`catalog did not refresh to ${description ?? 'empty'}`)
      }

      write({ description: 'First skill' })
      await until({ description: 'First skill' })
      write({ description: 'Edited skill' })
      await until({ description: 'Edited skill' })
      const replacement = `${path}.replacement`
      writeFileSync(
        replacement,
        '---\nname: review\ndescription: Replaced skill\n---\n',
      )
      renameSync(
        replacement,
        path,
      )
      await until({ description: 'Replaced skill' })
      rmSync(path)
      await until({})
    },
  )
}

test(
  'catalog edits refresh only scopes observing that path',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-catalog-scopes-',
    ))
    const paths = [
      'one',
      'two',
    ].map(name => join(
      root,
      name,
    ))
    paths.forEach(path => writeFileSync(
      path,
      'initial',
    ))
    const scans = new Map<string, number>()
    const index = createCatalogIndex({
      scan: async ({
        card,
        observe,
      }) => {
        const path = card.agent!.cwd!
        scans.set(
          path,
          (scans.get(path) ?? 0) + 1,
        )
        observe?.({ path })

        return { suggestions: [] }
      },
    })
    t.after(() => {
      index.close()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const cards = paths.map(cwd => {
      const decision = decidePush({
        state: emptyHydra(),
        newCardId: cwd,
        key: cwd,
        input: {
          agent: {
            provider: 'codex',
            sessionId: cwd,
            cwd,
          },
        },
        meta: {
          actor: 'test',
          at: '2026-10-23T10:00:00Z',
        },
      })
      assert.ok('event' in decision)

      return reduce({
        state: emptyHydra(),
        event: decision.event,
      }).cards[cwd]!
    })
    await Promise.all(cards.map(card => index.read({ card })))
    writeFileSync(
      paths[0],
      'edited',
    )
    const deadline = Date.now() + 5000

    while (scans.get(paths[0]) === 1) {
      assert.ok(
        Date.now() < deadline,
        'edited scope was not refreshed',
      )
      await pause()
    }

    assert.equal(
      scans.get(paths[1]),
      1,
      'unrelated scope must retain its cached metadata',
    )
  },
)
