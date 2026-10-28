import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
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
  t: TestContext
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
    `${provider} separates built-in Hydra skills from user skills and hides internal instructions`,
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

      const result = await readCatalog({
        card: {
          ...card,
          id: '$hydra',
        },
        locations,
      })
      assert.deepEqual(
        result.suggestions.map(item => item.command),
        [
          `${prefix}inscribe`,
          `${prefix}pnyx-set-up`,
          `${prefix}aaa`,
          `${prefix}zzz`,
        ],
      )
      const session = await readCatalog({
        card,
        locations,
      })
      assert.deepEqual(
        session.suggestions.map(item => item.command),
        [
          `${prefix}aaa`,
          `${prefix}inscribe`,
          `${prefix}pnyx-set-up`,
          `${prefix}zzz`,
        ],
      )
    },
  )
}

test(
  'a fresh Hydra offers built-ins without projects or a session folder',
  async t => {
    const {
      card,
      locations,
    } = setup({ t })
    const result = await readCatalog({
      card: {
        ...card,
        id: '$hydra',
        agent: undefined,
      },
      locations,
    })
    assert.deepEqual(
      result.suggestions.map(item => [
        item.command,
        item.source,
        item.builtin,
      ]),
      [
        [
          '/inscribe',
          'Built-in',
          true,
        ],
        [
          '/pnyx-set-up',
          'Built-in',
          true,
        ],
      ],
    )
    assert.ok(result.unavailable)
  },
)

test(
  'built-ins preserve same-name global and project skills and namespaced plugins',
  async t => {
    const {
      card,
      cwd,
      home,
      locations,
    } = setup({ t })
    const project = join(
      home,
      'attached',
    )
    write({
      path: join(
        home,
        '.claude/skills/inscribe/SKILL.md',
      ),
      text: skill({ name: 'inscribe' }),
    })
    write({
      path: join(
        project,
        '.agents/skills/inscribe/SKILL.md',
      ),
      text: skill({ name: 'inscribe' }),
    })
    write({
      path: join(
        cwd,
        '.agents/skills/inscribe/SKILL.md',
      ),
      text: skill({
        name: 'inscribe',
        description: 'Owner local skill',
      }),
    })
    const plugin = join(
      home,
      'plugin',
    )
    write({
      path: join(
        plugin,
        'skills/inscribe/SKILL.md',
      ),
      text: skill({ name: 'inscribe' }),
    })
    write({
      path: join(
        locations.claude,
        'settings.json',
      ),
      text: JSON.stringify({ enabledPlugins: { 'sample@fixtures': true } }),
    })
    write({
      path: join(
        locations.claude,
        'plugins/installed_plugins.json',
      ),
      text: JSON.stringify({
        plugins: {
          'sample@fixtures': [
            {
              scope: 'user',
              installPath: plugin,
            },
          ],
        },
      }),
    })
    const result = await readCatalog({
      card: {
        ...card,
        id: '$hydra',
      },
      projects: [
        {
          name: 'Attached',
          path: project,
          detached: false,
        },
      ],
      locations,
    })
    assert.deepEqual(
      result.suggestions.map(item => [
        item.command,
        item.source,
      ]),
      [
        [
          '/inscribe',
          'Built-in',
        ],
        [
          '/pnyx-set-up',
          'Built-in',
        ],
        [
          '/inscribe',
          'Global · .claude',
        ],
        [
          '/sample:inscribe',
          'Plugin sample',
        ],
        [
          '/inscribe',
          'Project · Attached',
        ],
        [
          '/inscribe',
          'Session skills',
        ],
      ],
    )
    const selected = result.suggestions.find(item => item.project === 'Attached')
    assert.equal(
      selected?.file,
      join(
        project,
        '.agents/skills/inscribe/SKILL.md',
      ),
    )
  },
)
