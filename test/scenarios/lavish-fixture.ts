import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Card } from '../../src/core/model.ts'
import { steeringClaim } from '../../src/task-inbox/state.ts'
import type { scenarioGroup } from './harness.ts'

type Scenario = Awaited<ReturnType<ReturnType<typeof scenarioGroup>['scenario']>>

export function lavishFixture({ folder }: { folder: string }) {
  const executable = join(
    folder,
    'lavish-axi',
  )
  const page = join(
    folder,
    'review.html',
  )
  const reply = join(
    folder,
    'reply.md',
  )
  copyFileSync(
    join(
      import.meta.dirname,
      '../fixtures/external-sources/lavish-axi.mjs',
    ),
    executable,
  )
  chmodSync(
    executable,
    0o755,
  )
  writeFileSync(
    page,
    '<html>Fixture review</html>',
  )
  writeFileSync(
    reply,
    'Applied the requested changes.\nKept the labels.',
  )

  return {
    page,
    executable,
    reply,
    arm({
      task,
      id,
      after,
      card,
    }: {
      task: string
      id: string
      after?: string
      card?: Card
    }) {
      const args = [
        'task',
        'source',
        'lavish',
        task,
        id,
        '--page',
        page,
        '--executable',
        executable,
      ]

      if (after && card) {
        args.push(
          '--after',
          after,
          '--sequence',
          '1',
          '--agent-reply-file',
          reply,
          ...claimFlags({ card }),
        )
      }

      return args
    },
    deliver({ body }: { body: string }) {
      writeFileSync(
        join(
          folder,
          'deliver.toon',
        ),
        body,
      )
    },
    calls() {
      return readFileSync(
        join(
          folder,
          'calls.jsonl',
        ),
        'utf8',
      ).trim()
        .split('\n')
        .map(line => JSON.parse(line) as {
          action: string
          text?: string
        })
    },
  }
}

export function claimFlags({ card }: { card: Card }): string[] {
  const claim = steeringClaim({ card })

  if (!claim) {
    throw new Error('Fixture needs an assigned worker')
  }

  return [
    '--session',
    claim.session,
    '--generation',
    String(claim.generation),
  ]
}

export async function readAndAck({
  s,
  worker,
  task,
  id,
}: {
  s: Scenario
  worker: ReturnType<Scenario['as']>
  task: string
  id: string
}) {
  const card = s.task({ key: task })
  const result = card.externalSources?.find(source => source.id === id)?.results[0]

  if (!result) {
    throw new Error('Fixture needs a captured result')
  }

  await worker.run({
    args: [
      'task',
      'source',
      'read',
      task,
      id,
    ],
  })
  await worker.run({
    args: [
      'task',
      'inbox',
      'read',
      task,
    ],
  })

  for (const message of card.steering ?? []) {
    if (!message.ack) {
      await worker.run({
        args: [
          'task',
          'inbox',
          'ack',
          task,
          message.id,
          ...claimFlags({ card }),
        ],
      })
    }

    if (message.id === result.message) {
      break
    }
  }

  return result
}
