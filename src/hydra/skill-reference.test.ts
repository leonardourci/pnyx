import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileBlock } from './attachments.ts'
import { reference } from './mentions.ts'
import { readSkillReference, resolveSkillReferences, skillReference } from './transcripts-skill-reference.ts'

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
