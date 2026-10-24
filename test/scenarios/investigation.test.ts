import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { REPORT_MAX_CHARS } from '../../src/investigation/report.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup({ incorporateSteering: true })

test(
  'an investigation is done only with a stored report, and the owner turns it into a build its worker continues in the same copy, which still has to land',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({ name: 'billing' })
    const hydra = s.as({ agent: await s.chat({ text: 'Find out why exports are slow.' }) })
    await hydra.run({
      args: [
        'task',
        'create',
        '--title',
        'Slow exports',
        '--key',
        'slow',
        '--project',
        app,
        '--kind',
        'investigation',
        '--reason',
        'the owner asked why',
      ],
    })
    await hydra.run({
      args: [
        'task',
        'start',
        'slow',
        '--reason',
        'the owner asked why',
      ],
    })
    const copy = s.task({ key: 'slow' }).copy!.path
    const agent = await s.agent({ cwd: copy })
    const worker = s.as({ agent })
    const id = s.task({ key: 'slow' }).id
    assert.match(
      agent.received[0]!,
      /^Investigation: answer the brief with a report that stands alone .* then declare done\. A report does not authorize building/m,
    )
    assert.doesNotMatch(
      agent.received[0]!,
      /^Landing:/m,
    )

    assert.deepEqual(
      [
        await worker.refusal({
          args: [
            'task',
            'status',
            'slow',
            'done',
          ],
        }),
        await s.ownerRefusal({
          args: [
            'task',
            'build',
            'slow',
          ],
        }),
      ],
      [
        {
          code: 'NOT_LANDED',
          error: `not done yet: no stored report: store it with \`pnyx-axi task report ${id} --file <path> --hydra ${s.hydraId}\``,
        },
        {
          code: 'CONFLICT',
          error: `task ${id} has no stored report to build from`,
        },
      ],
    )

    const file = ({
      name,
      text,
    }: {
      name: string
      text: string
    }) => {
      const path = join(
        s.folder({ name: 'reports' }),
        name,
      )
      writeFileSync(
        path,
        text,
      )

      return path
    }

    for (const {
      name,
      text,
      error,
    } of [
        {
          name: 'blank.md',
          text: '  \n',
          error: 'the report is empty',
        },
        {
          name: 'huge.md',
          text: 'x'.repeat(REPORT_MAX_CHARS + 1),
          error: `keep it under ${REPORT_MAX_CHARS}`,
        },
      ]) {
      const refusal = await worker.refusal({
        args: [
          'task',
          'report',
          'slow',
          '--file',
          file({
            name,
            text,
          }),
        ],
      })
      assert.equal(
        refusal.code,
        'VALIDATION_ERROR',
      )
      assert.ok(
        refusal.error?.includes(error),
        refusal.error,
      )
    }

    const missing = join(
      s.folder({ name: 'reports' }),
      'missing.md',
    )
    assert.deepEqual(
      [
        await worker.refusal({
          args: [
            'task',
            'report',
            'slow',
            '--file',
            missing,
          ],
        }),
        s.events().filter(e => e.type === 'task.report').length,
      ],
      [
        {
          code: 'NOT_FOUND',
          error: `report file not readable: ${missing}`,
        },
        0,
      ],
    )

    const report = '# Slow exports\n\nThe export runs one query per invoice; batching them takes it from 40s to 2s.'
    await worker.run({
      args: [
        'task',
        'report',
        'slow',
        '--file',
        file({
          name: 'report.md',
          text: `${report}\n`,
        }),
      ],
    })
    assert.match(
      await s.owner({
        args: [
          'task',
          'report',
          'slow',
        ],
      }),
      /^report: "# Slow exports\\n\\nThe export runs one query per invoice; batching them takes it from 40s to 2s\."$/m,
    )
    await worker.run({
      args: [
        'task',
        'report-review',
        'slow',
        '--report',
        s.task({ key: 'slow' }).report!.id,
        '--none',
      ],
    })
    await worker.run({
      args: [
        'task',
        'status',
        'slow',
        'done',
        '--note',
        'Report stored',
      ],
    })
    assert.equal(
      s.task({ key: 'slow' }).column,
      s.column({ role: 'done' }),
    )
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'build',
          'slow',
        ],
      }),
      'FORBIDDEN',
    )

    assert.match(
      await s.owner({
        args: [
          'task',
          'build',
          'slow',
        ],
      }),
      /^worker: delivered$/m,
    )
    const buildMessages = ({ received }: { received: string[] }) => received.filter(text => text.startsWith('The owner approved building this.'))
    await until({
      what: 'the worker to finish its build turn',
      check: () => buildMessages({ received: s.received({ cwd: copy }) }).length > 0 && s.task({ key: 'slow' }).sessionActivity === 'finished',
    })
    const [message] = buildMessages({ received: s.received({ cwd: copy }) })
    assert.match(
      message!,
      /Start the build on a fresh branch from the up-to-date default branch.* Landing: commit on your branch, push it, open a ready pull request/,
    )
    const built = s.task({ key: 'slow' })
    // The card left Done before it became a build, so no saved state had a build in Done to settle.
    const kind = s.events().find(e => e.type === 'task.kind' && e.cardId === id)!
    const reopened = s.events().find(e => e.type === 'task.declared' && e.cardId === id
      && e.data.note === 'Building from its investigation')!
    assert.ok(reopened.seq < kind.seq)
    assert.deepEqual(
      [
        built.kind,
        built.column,
        built.copy?.state,
        built.copy?.path,
        built.agent?.sessionId,
        (await s.agent({ cwd: copy })).resumed,
      ],
      [
        'build',
        s.column({ role: 'in_progress' }),
        'active',
        copy,
        agent.id,
        false,
      ],
    )

    writeFileSync(
      join(
        copy,
        'batch.ts',
      ),
      'export {}\n',
    )
    assert.deepEqual(
      [
        (await worker.refusal({
          args: [
            'task',
            'status',
            'slow',
            'done',
          ],
        })).error,
        (await s.ownerRefusal({
          args: [
            'task',
            'build',
            'slow',
          ],
        })).error,
        buildMessages({ received: s.received({ cwd: copy }) }).length,
      ],
      [
        'not done yet: 1 file uncommitted',
        `task ${id} is already a build task`,
        1,
      ],
    )

    // An investigation nobody is working on becomes a build that waits in Queued, and its worker starts from the report.
    const folder = s.folder({ name: 'cache' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Cache misses',
        '--key',
        'misses',
        '--folder',
        folder,
        '--kind',
        'investigation',
      ],
    })
    await s.owner({
      args: [
        'task',
        'report',
        'misses',
        '--file',
        file({
          name: 'misses.md',
          text: 'The cache key ignores the locale.\n',
        }),
      ],
    })
    await s.owner({
      args: [
        'task',
        'report-review',
        'misses',
        '--report',
        s.task({ key: 'misses' }).report!.id,
        '--none',
      ],
    })
    await s.owner({
      args: [
        'task',
        'build',
        'misses',
      ],
    })
    assert.deepEqual(
      [
        s.task({ key: 'misses' }).kind,
        s.task({ key: 'misses' }).column,
      ],
      [
        'build',
        s.column({ role: 'queued' }),
      ],
    )
    await hydra.run({
      args: [
        'task',
        'start',
        'misses',
        '--reason',
        'the owner approved the build',
      ],
    })
    const opening = (await s.agent({ cwd: folder })).received[0]!
    assert.ok(
      opening.includes(`This task began as an investigation; read its stored report with \`pnyx-axi task report ${s.task({ key: 'misses' }).id} --hydra ${s.hydraId}\` before building.`),
      opening,
    )
  },
)
