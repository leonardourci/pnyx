import { resolveSkillReferences } from './skill-invocation.ts'
import { skillSource } from '#setup/skills.ts'
import { withBuiltInSkills } from './built-in-skills.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileBlock } from './attachments.ts'
import { reference } from './mentions.ts'
import { readSkillReference, skillReference } from './transcripts-skill-reference.ts'

const project = {
  command: '$deploy',
  description: 'Deploy the app',
  source: 'Project · Sample',
  file: '/demo/Sample/.agents/skills/deploy/SKILL.md',
  project: 'Sample',
  projectPath: '/demo/Sample',
}

test(
  'native skill syntax follows the receiving harness at send time',
  () => {
    const token = skillReference({
      item: {
        command: '$review',
        description: 'Review',
        source: 'Global',
      },
    })
    assert.equal(
      resolveSkillReferences({
        text: token,
        provider: 'claude-code',
      }),
      '/review',
    )
    assert.equal(
      resolveSkillReferences({
        text: token,
        provider: 'codex',
      }),
      '$review',
    )
    const command = skillReference({
      item: {
        command: '/prompts:draft',
        kind: 'command',
        description: 'Draft',
        source: 'Prompts',
      },
    })
    assert.equal(
      resolveSkillReferences({
        text: command,
        provider: 'codex',
      }),
      '/prompts:draft',
    )
  },
)

test(
  'invalid tokens and skill references inside attached file contents stay literal',
  () => {
    const invalid = reference({
      kind: 'skill',
      value: JSON.stringify({
        name: 'deploy',
        file: '../SKILL.md',
      }),
      label: '/deploy',
    })
    assert.equal(
      readSkillReference({ value: '{bad' }),
      undefined,
    )
    assert.equal(
      resolveSkillReferences({
        text: invalid,
        provider: 'codex',
      }),
      invalid,
    )
    const attachment = fileBlock({
      name: 'sample.md',
      text: skillReference({ item: project }),
    })
    assert.equal(
      resolveSkillReferences({
        text: attachment,
        provider: 'codex',
      }),
      attachment,
    )
  },
)

test(
  'a failed catalog still offers built-ins that resolve to the shipped skill',
  () => {
    const catalog = withBuiltInSkills({
      card: '$hydra',
      provider: 'codex',
      catalog: {
        suggestions: [],
        unavailable: 'Commands unavailable. Close and reopen to retry.',
      },
    })
    assert.deepEqual(
      catalog.suggestions.map(item => [
        item.command,
        item.source,
      ]),
      [
        [
          '$inscribe',
          'Built-in',
        ],
        [
          '$pnyx-set-up',
          'Built-in',
        ],
        [
          '/upgrade',
          'Built-in',
        ],
        [
          '/add-project',
          'Built-in',
        ],
      ],
    )
    assert.equal(
      catalog.unavailable,
      'Commands unavailable. Close and reopen to retry.',
    )
    const selected = catalog.suggestions.find(item => item.command === '$inscribe')
    assert.ok(selected)
    assert.equal(
      resolveSkillReferences({
        text: skillReference({ item: selected }),
        provider: 'codex',
      }),
      `Read and follow the skill "inscribe" at ${JSON.stringify(skillSource({ name: 'inscribe' }))}.`,
    )
    const upgrade = catalog.suggestions.find(item => item.command === '/upgrade')
    assert.ok(upgrade)
    assert.equal(
      resolveSkillReferences({
        text: skillReference({ item: upgrade }),
        provider: 'codex',
      }),
      '/upgrade',
    )
    const worker = withBuiltInSkills({
      card: 'worker',
      catalog: { suggestions: [] },
    })
    assert.deepEqual(
      worker.suggestions,
      [],
    )
  },
)
