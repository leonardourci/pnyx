import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '../../src/core/hydra.ts'
import { taskMention } from '../../src/mentions/mentions.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'each wake says why: a worker\'s finished turn, its needs_you note, and its done freeing a slot for the ready Backlog card but not a held one',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'app' })

    for (const [
      title,
      key,
      ...rest
    ] of [
        [
          'Fix date parsing',
          'fix',
          '--folder',
          folder,
        ],
        [
          'Add CSV export',
          'csv',
        ],
        [
          'Rework the schema',
          'schema',
        ],
      ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          title!,
          '--key',
          key!,
          ...rest,
        ],
      })
    }

    await s.owner({
      args: [
        'task',
        'status',
        'schema',
        'paused',
        '--hold',
        '--note',
        'The owner wants to talk first',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Watch the work',
      ],
    })
    const hydra = await s.agent({ hydra: true })
    const wakes = () => hydra.received.filter(text => text.startsWith('<pnyx-wake>'))
    const ref = ({ key }: { key: string }) => taskMention({
      id: s.task({ key }).id,
      title: s.task({ key }).title,
    })
    await until({
      what: 'Hydra to finish the owner\'s turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })

    await s.owner({
      args: [
        'task',
        'start',
        'fix',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    const turnEnded = await until({
      what: 'a wake for the worker\'s finished opening turn',
      check: () => wakes().find(text => text.includes(`- ${ref({ key: 'fix' })} turn ended: the worker finished its turn`)),
    })
    assert.ok(turnEnded.startsWith('<pnyx-wake>Why you are woken:\n'))
    assert.ok(turnEnded.includes('always gets a reply'))

    await worker.run({
      args: [
        'task',
        'status',
        'fix',
        'needs_you',
        '--note',
        'Which parser should own dates?',
      ],
    })
    await until({
      what: 'a wake naming the needs_you note',
      check: () => wakes().some(text => text.includes(`- ${ref({ key: 'fix' })} declared: needs_you, "Which parser should own dates?"`)),
    })

    await worker.run({
      args: [
        'task',
        'status',
        'fix',
        'done',
        '--note',
        'Dates parse in one place now',
      ],
    })
    const slot = await until({
      what: 'a wake saying a slot is free',
      check: () => wakes().find(text => text.includes('- slot free: ')),
    })
    assert.ok(slot.includes(`- slot free: ready in Backlog, in order: ${ref({ key: 'csv' })}\n`))
    assert.ok(
      !slot.includes('Rework the schema'),
      'a held card is not ready',
    )
  },
)
