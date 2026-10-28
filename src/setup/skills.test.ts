import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { copySkills, prepareHydraFolder, setupSkills, skillSource } from './skills.ts'

function folder({ t }: { t: TestContext }) {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-skills-',
  ))
  t.after(() => rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  ))

  return root
}

test(
  'preparing a Hydra retires pnyx-inscribe and keeps inscribe across repeated preparation',
  t => {
    const root = folder({ t })
    const legacy = join(
      root,
      '.agents/skills/pnyx-inscribe',
    )
    mkdirSync(
      legacy,
      { recursive: true },
    )
    writeFileSync(
      join(
        legacy,
        'SKILL.md',
      ),
      'old Pnyx instruction',
    )
    prepareHydraFolder({ folder: root })
    prepareHydraFolder({ folder: root })
    assert.equal(
      existsSync(legacy),
      false,
    )
    assert.equal(
      readFileSync(
        join(
          root,
          '.agents/skills/inscribe/SKILL.md',
        ),
        'utf8',
      ),
      readFileSync(
        skillSource({ name: 'inscribe' }),
        'utf8',
      ),
    )
    assert.equal(
      existsSync(join(
        root,
        '.claude/skills/inscribe/SKILL.md',
      )),
      true,
    )
  },
)

test(
  'global setup preserves an owner skill named inscribe',
  t => {
    const home = folder({ t })
    const path = join(
      home,
      '.agents/skills/inscribe',
    )
    mkdirSync(
      path,
      { recursive: true },
    )
    writeFileSync(
      join(
        path,
        'SKILL.md',
      ),
      'Owner skill',
    )
    setupSkills({
      userHome: home,
      claudeConfigDir: join(
        home,
        '.claude',
      ),
    })
    assert.equal(
      readFileSync(
        join(
          path,
          'SKILL.md',
        ),
        'utf8',
      ),
      'Owner skill',
    )
  },
)

test(
  'copying Hydra skills refuses an unowned inscribe before installing anything',
  t => {
    const root = folder({ t })
    const path = join(
      root,
      '.agents/skills/inscribe',
    )
    mkdirSync(
      path,
      { recursive: true },
    )
    writeFileSync(
      join(
        path,
        'SKILL.md',
      ),
      'Owner skill',
    )
    assert.throws(
      () => copySkills({
        folder: root,
        names: [
          'pnyx-set-up',
          'inscribe',
        ],
        owns: () => false,
      }),
      { code: 'SKILL_CONFLICT' },
    )
    assert.equal(
      readFileSync(
        join(
          path,
          'SKILL.md',
        ),
        'utf8',
      ),
      'Owner skill',
    )
    assert.equal(
      existsSync(join(
        root,
        '.agents/skills/pnyx-set-up',
      )),
      false,
    )
  },
)

test(
  'global setup no longer retires a Pnyx inscribe link',
  t => {
    const home = folder({ t })
    const path = join(
      home,
      '.agents/skills/inscribe',
    )
    mkdirSync(
      dirname(path),
      { recursive: true },
    )
    symlinkSync(
      dirname(skillSource({ name: 'inscribe' })),
      path,
      'dir',
    )
    setupSkills({
      userHome: home,
      claudeConfigDir: join(
        home,
        '.claude',
      ),
    })
    assert.equal(
      readFileSync(
        join(
          path,
          'SKILL.md',
        ),
        'utf8',
      ),
      readFileSync(
        skillSource({ name: 'inscribe' }),
        'utf8',
      ),
    )
  },
)
