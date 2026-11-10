import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSkillReference, skillReference } from '#hydra/transcripts-skill-reference.ts'
import { decodeValue } from '#hydra/mentions.ts'
import { skillIcon, slashIcons } from './skill-icons.ts'

test(
  'inscribe keeps its icon in slash menus and serialized chat references for both harnesses',
  () => {
    const claude = {
      command: '/inscribe',
      builtin: true,
      description: '',
      source: 'Built-in',
    }
    const codex = {
      ...claude,
      command: '$inscribe',
    }
    assert.deepEqual(
      slashIcons({ item: claude }),
      ['inscribe'],
    )
    assert.deepEqual(
      slashIcons({ item: codex }),
      ['inscribe'],
    )
    const reference = skillReference({ item: codex })
    const encoded = reference.slice(
      reference.indexOf('pnyx-skill:') + 'pnyx-skill:'.length,
      -1,
    )
    const decoded = decodeValue({ value: encoded })
    assert.ok(decoded)
    const skill = readSkillReference({ value: decoded })
    assert.ok(skill)
    assert.equal(
      skillIcon({ skill }),
      'inscribe',
    )
    assert.equal(
      skillIcon({ skill: { name: 'inscribe' } }),
      'star',
    )
    assert.equal(
      skillIcon({
        skill: {
          name: 'other',
          builtin: true,
        },
      }),
      'star',
    )
  },
)

test(
  'existing command icons keep their mappings',
  () => {
    assert.equal(
      skillIcon({
        skill: {
          name: 'upgrade',
          command: '/upgrade',
        },
      }),
      'upgrade',
    )
    assert.equal(
      skillIcon({
        skill: {
          name: 'restart',
          command: '/restart',
        },
      }),
      'restart',
    )
    assert.deepEqual(
      slashIcons({
        item: {
          command: '/compact',
          source: 'Agent commands',
          description: '',
        },
      }),
      ['compact'],
    )
    assert.deepEqual(
      slashIcons({
        item: {
          command: '/add-project',
          source: 'Built-in',
          description: '',
        },
      }),
      ['attach'],
    )
    assert.equal(
      slashIcons({
        item: {
          command: '/inscribe',
          source: 'Project',
          description: '',
        },
      }),
      undefined,
    )
  },
)
