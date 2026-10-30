import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { moveOwnerLearning, ownerMemory } from './owner-memory.ts'
import { projectMemoryView, writeProjectMemory } from './project-memory.ts'

const scratch = realpathSync(mkdtempSync(join(
  tmpdir(),
  'pnyx-archive-',
)))
after(() => rmSync(
  scratch,
  {
    recursive: true,
    force: true,
  },
))

const SEEDED_AT = '2026-10-01T12:00:00.000Z'
const REMOVED_AT = '2026-10-29T12:00:00.000Z'

const newHome = ({ name }: { name: string }) => {
  process.env.PNYX_HOME = mkdtempSync(join(
    scratch,
    `${name}-`,
  ))

  return mkdtempSync(join(
    scratch,
    'folder-',
  ))
}

const ownerArchived = async () => {
  const listed = await commands.owner(['memory']) as {
    archived: {
      key: string
      text: string
      reason?: string
    }[]
  }

  return listed.archived.map(line => ({
    key: line.key,
    text: line.text,
    reason: line.reason,
  }))
}

test(
  'owner lines dropped by a set, an archive or a forget are listed with that change\'s reason until a set restores them',
  async () => {
    newHome({ name: 'owner' })
    const owner = ({ args }: { args: string[] }) => commands.owner([
      'memory',
      ...args,
    ])

    await owner({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Short PRs.\nMerge commits only.',
        '--reason',
        'seed',
      ],
    })
    await owner({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Short PRs.',
        '--reason',
        'rewrote preferences',
      ],
    })
    await owner({
      args: [
        'set',
        '--key',
        'learnings',
        '--text',
        'Old fact\nNew fact',
        '--reason',
        'seed',
      ],
    })
    await owner({
      args: [
        'archive',
        '--text',
        'Old fact',
        '--reason',
        'tool changed',
      ],
    })
    await owner({
      args: [
        'forget',
        '--key',
        'learnings',
        '--reason',
        'all outdated',
      ],
    })

    assert.deepEqual(
      await ownerArchived(),
      [
        {
          key: 'preferences',
          text: 'Merge commits only.',
          reason: 'rewrote preferences',
        },
        {
          key: 'learnings',
          text: 'Old fact',
          reason: 'tool changed',
        },
        {
          key: 'learnings',
          text: 'New fact',
          reason: 'all outdated',
        },
      ],
    )

    await owner({
      args: [
        'set',
        '--key',
        'preferences',
        '--text',
        'Short PRs.\nMerge commits only.',
        '--reason',
        'restored',
      ],
    })
    assert.deepEqual(
      (await ownerArchived()).map(line => line.text),
      [
        'Old fact',
        'New fact',
      ],
    )
  },
)

test(
  'an owner learning moved to a project is not archived',
  async () => {
    const path = newHome({ name: 'move' })
    await commands.owner([
      'memory',
      'set',
      '--key',
      'learnings',
      '--text',
      'Move me\nKeep me',
      '--reason',
      'seed',
    ])
    moveOwnerLearning({
      path,
      hydraId: 'lab',
      text: 'Move me',
      meta: {
        at: REMOVED_AT,
        actor: 'hydra',
        reason: 'project only',
      },
    })

    assert.equal(
      ownerMemory().learnings?.text,
      'Keep me',
    )
    assert.deepEqual(
      await ownerArchived(),
      [],
    )
    assert.equal(
      projectMemoryView({ path }).documents.learnings,
      'Move me',
    )
  },
)

test(
  'project lines dropped by a set or forget are listed with its date and reason; lines a profile refresh drops are not',
  () => {
    const path = newHome({ name: 'project' })
    const save = ({
      key,
      text,
      at,
      reason,
    }: {
      key: 'profile' | 'preferences'
      text: string | null
      at: string
      reason: string
    }) => writeProjectMemory({
      path,
      hydraId: 'lab',
      key,
      after: text,
      sources: projectMemoryView({ path }).currentSources.fingerprint,
      meta: {
        at,
        actor: 'hydra',
        reason,
      },
    })

    save({
      key: 'profile',
      text: 'Build with make.',
      at: SEEDED_AT,
      reason: 'seed',
    })
    save({
      key: 'profile',
      text: 'Build with pnpm.',
      at: REMOVED_AT,
      reason: 'sources changed',
    })
    save({
      key: 'preferences',
      text: 'One icon library.\nSliders for numbers.',
      at: SEEDED_AT,
      reason: 'seed',
    })
    save({
      key: 'preferences',
      text: null,
      at: REMOVED_AT,
      reason: 'owner dropped them',
    })

    assert.deepEqual(
      projectMemoryView({ path }).archived,
      [
        {
          key: 'preferences',
          text: 'One icon library.',
          at: REMOVED_AT,
          reason: 'owner dropped them',
        },
        {
          key: 'preferences',
          text: 'Sliders for numbers.',
          at: REMOVED_AT,
          reason: 'owner dropped them',
        },
      ],
    )

    save({
      key: 'preferences',
      text: 'One icon library.\nSliders for numbers.',
      at: REMOVED_AT,
      reason: 'owner restored them',
    })
    assert.deepEqual(
      projectMemoryView({ path }).archived,
      [],
    )
  },
)
