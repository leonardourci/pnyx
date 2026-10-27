import {
  ORCHESTRATE_SKILL,
  ARRANGE_COLUMNS_SKILL,
  MANAGE_WORKERS_SKILL,
  FIRSTMATE_AS_HYDRA_SKILL,
  SET_UP_SKILL,
  INSCRIBE_SKILL,
  REPORT_PROGRESS_SKILL,
  CLI_SKILL,
  HYDRA_SKILLS,
} from '../src/integrations/skills/names.ts'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { prepareHydraFolder, setupSkills, skillLinks, skillStatus } from '../src/integrations/skills/install.ts'

test(
  'global skill links cover both harnesses, stay current and remove only links',
  t => {
    const userHome = mkdtempSync(join(
      tmpdir(),
      'pnyx-skills-',
    ))
    t.after(() => rmSync(
      userHome,
      {
        recursive: true,
        force: true,
      },
    ))
    const options = {
      userHome,
      claudeConfigDir: join(
        userHome,
        'custom-claude',
      ),
    }
    const preview = setupSkills({
      ...options,
      preview: true,
    })
    assert.equal(
      preview.skills.length,
      4,
    )
    assert.ok(preview.skills.every(link => link.change === 'installed' && !existsSync(link.path)))
    assert.match(
      skillStatus(options),
      /missing:/,
    )
    const installed = setupSkills(options)
    assert.deepEqual(
      readdirSync(join(
        userHome,
        '.agents',
        'skills',
      )).sort(),
      [
        CLI_SKILL,
        REPORT_PROGRESS_SKILL,
      ],
    )
    assert.deepEqual(
      readdirSync(join(
        options.claudeConfigDir,
        'skills',
      )).sort(),
      [
        CLI_SKILL,
        REPORT_PROGRESS_SKILL,
      ],
    )

    for (const link of installed.skills) {
      const text = readFileSync(
        join(
          link.path,
          'SKILL.md',
        ),
        'utf8',
      )
      const meta = parse(text.split('---')[1]!)
      assert.equal(
        meta.name,
        link.name,
      )
      assert.equal(
        meta['user-invocable'],
        false,
      )
      assert.equal(
        meta.metadata.internal,
        true,
      )
      assert.ok(lstatSync(link.path).isSymbolicLink())
      assert.equal(
        readlinkSync(link.path),
        link.source,
      )
      assert.equal(
        readFileSync(
          join(
            link.path,
            'SKILL.md',
          ),
          'utf8',
        ),
        readFileSync(
          join(
            link.source,
            'SKILL.md',
          ),
          'utf8',
        ),
      )
    }

    assert.ok(!existsSync(join(
      userHome,
      '.claude',
    )))
    assert.equal(
      skillStatus(options),
      'ready',
    )
    assert.ok(setupSkills(options).skills.every(link => link.change === 'unchanged'))
    setupSkills({
      ...options,
      remove: true,
      preview: true,
    })
    assert.equal(
      skillStatus(options),
      'ready',
    )
    setupSkills({
      ...options,
      remove: true,
    })
    assert.ok(installed.skills.every(link => !existsSync(link.path) && existsSync(join(
      link.source,
      'SKILL.md',
    ))))
    assert.ok(setupSkills({
      ...options,
      remove: true,
    }).skills.every(link => link.change === 'unchanged'))
  },
)

test(
  'conflicting directories, files and dangling links are preserved without partial setup',
  t => {
    const userHome = mkdtempSync(join(
      tmpdir(),
      'pnyx-skills-conflict-',
    ))
    t.after(() => rmSync(
      userHome,
      {
        recursive: true,
        force: true,
      },
    ))
    const options = {
      userHome,
      claudeConfigDir: '',
    }
    const links = skillLinks(options)
    const conflict = links.at(-1)!
    mkdirSync(
      dirname(conflict.path),
      { recursive: true },
    )

    for (const kind of [
      'directory',
      'file',
      'link',
    ]) {
      if (kind === 'directory') {
        mkdirSync(conflict.path)
        writeFileSync(
          join(
            conflict.path,
            'SKILL.md',
          ),
          'User skill',
        )
      } else if (kind === 'file') {
        writeFileSync(
          conflict.path,
          'User skill',
        )
      } else {
        symlinkSync(
          join(
            userHome,
            'missing',
          ),
          conflict.path,
        )
      }

      assert.throws(
        () => setupSkills(options),
        { code: 'SKILL_CONFLICT' },
      )
      assert.ok(!existsSync(links[0]!.path))
      assert.match(
        skillStatus(options),
        /conflict:/,
      )
      assert.ok(setupSkills({
        ...options,
        remove: true,
      }).skills.every(link => link.change === 'unchanged'))
      assert.ok(lstatSync(conflict.path))
      rmSync(
        conflict.path,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra preparation installs all internal skills and loads its contract every turn',
  t => {
    const folder = mkdtempSync(join(
      tmpdir(),
      'pnyx-internal-skills-',
    ))
    t.after(() => rmSync(
      folder,
      {
        recursive: true,
        force: true,
      },
    ))
    prepareHydraFolder({
      folder,
      instructions: 'Task instructions',
    })
    assert.deepEqual(
      readdirSync(join(
        folder,
        '.agents',
        'skills',
      )).sort(),
      [
        ARRANGE_COLUMNS_SKILL,
        FIRSTMATE_AS_HYDRA_SKILL,
        INSCRIBE_SKILL,
        MANAGE_WORKERS_SKILL,
        ORCHESTRATE_SKILL,
        SET_UP_SKILL,
      ],
    )

    for (const name of HYDRA_SKILLS) {
      const text = readFileSync(
        join(
          folder,
          '.claude',
          'skills',
          name,
          'SKILL.md',
        ),
        'utf8',
      )
      const meta = parse(text.split('---')[1]!)
      assert.equal(
        meta.name,
        name,
      )
      assert.equal(
        meta['user-invocable'],
        false,
      )
      assert.equal(
        meta.metadata.internal,
        true,
      )
    }

    const contract = readFileSync(
      join(
        folder,
        'AGENTS.md',
      ),
      'utf8',
    )
    assert.ok(contract.startsWith('Task instructions\n\n# Hydra\n'))
    assert.ok(contract.includes(`load \`${MANAGE_WORKERS_SKILL}\``))
    assert.equal(
      readFileSync(
        join(
          folder,
          'CLAUDE.md',
        ),
        'utf8',
      ),
      '@AGENTS.md\n',
    )
    const skills = join(
      folder,
      '.agents',
      'skills',
    )

    for (const name of [
      'pnyx-hydra',
      'pnyx-hydra-workers',
      'pnyx-hydra-columns',
      'pnyx-hydra-firstmate',
      'pnyx-setup',
      'inscribe',
    ]) {
      mkdirSync(
        join(
          skills,
          name,
        ),
        { recursive: true },
      )
      writeFileSync(
        join(
          skills,
          name,
          'SKILL.md',
        ),
        `---\nname: ${name}\n---\nLegacy Pnyx contract`,
      )
    }

    mkdirSync(join(
      skills,
      'owner-helper',
    ))
    writeFileSync(
      join(
        skills,
        'owner-helper',
        'SKILL.md',
      ),
      'Owner skill',
    )
    prepareHydraFolder({ folder })
    assert.deepEqual(
      readdirSync(skills).sort(),
      [
        'owner-helper',
        ...HYDRA_SKILLS,
      ].sort(),
    )
    assert.equal(
      readFileSync(
        join(
          skills,
          'owner-helper',
          'SKILL.md',
        ),
        'utf8',
      ),
      'Owner skill',
    )
    assert.ok(readFileSync(
      join(
        folder,
        'AGENTS.md',
      ),
      'utf8',
    ).startsWith('# Hydra\n'))
  },
)
