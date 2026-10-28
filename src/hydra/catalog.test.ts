import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { readCatalog } from './transcripts-catalog.ts'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { decidePush } from '#tasks/push.ts'

const write = ({
  path,
  text,
}: {
  path: string
  text: string
}) => {
  mkdirSync(
    dirname(path),
    { recursive: true },
  ); writeFileSync(
    path,
    text,
  )
}

const skill = ({
  name,
  description = 'Local fixture skill',
  extra = '',
}: {
  name: string
  description?: string
  extra?: string
}) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\nNever executed: $(touch not-a-command)\n`

function setup({
  t,
  provider = 'claude',
}: {
  t: { after(fn: () => void): void }
  provider?: string
}) {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-catalog-',
  )); t.after(() => rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  ))
  const cwd = join(
    home,
    'project/service',
  ); mkdirSync(
    cwd,
    { recursive: true },
  ); write({
    path: join(
      home,
      'project/.git',
    ),
    text: 'fixture worktree marker',
  })
  const decision = decidePush({
    state: emptyHydra(),
    newCardId: `c${emptyHydra().seq + 1}`,
    key: 'fixture',
    input: {
      agent: {
        provider,
        sessionId: 'fixture-session',
        cwd,
      },
    },
    meta: {
      actor: 'test',
      at: '2026-10-14T10:00:00Z',
    },
  }); assert.ok('event' in decision)
  const card = reduce({
    state: emptyHydra(),
    event: decision.event,
  }).cards.c1!

  return {
    home,
    cwd,
    card,
    locations: {
      home,
      claude: join(
        home,
        '.claude',
      ),
      codex: join(
        home,
        '.codex',
      ),
    },
  }
}

for (const provider of [
  'claude',
  'codex',
]) {
  test(
    `${provider} hides every Pnyx skill and preserves the remaining skill order`,
    async t => {
      const {
        home,
        cwd,
        card,
        locations,
      } = setup({
        t,
        provider,
      })
      const {
        setupSkills,
        prepareHydraFolder,
      } = await import('#setup/skills.ts')
      setupSkills({
        userHome: home,
        claudeConfigDir: locations.claude,
      })
      prepareHydraFolder({ folder: cwd })
      write({
        path: join(
          home,
          '.agents/skills/aaa/SKILL.md',
        ),
        text: skill({ name: 'aaa' }),
      })
      write({
        path: join(
          cwd,
          '.agents/skills/zzz/SKILL.md',
        ),
        text: skill({ name: 'zzz' }),
      })
      const prefix = provider === 'codex' ? '$' : '/'

      for (const id of [
        card.id,
        '$hydra',
      ]) {
        const result = await readCatalog({
          card: {
            ...card,
            id,
          },
          locations,
        })
        assert.deepEqual(
          result.suggestions.map(item => item.command),
          [
            `${prefix}aaa`,
            `${prefix}zzz`,
          ],
        )
      }
    },
  )
}
