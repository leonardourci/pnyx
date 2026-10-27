import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { browserFixture } from './browser-fixture.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { startServer } from '../src/server/server.ts'
import { withWriter } from '../src/store/hydra-store.ts'

const browser = browserFixture()

test(
  'chat decisions load history, resolve inline, and retain native history through updates and reconnect',
  {
    timeout: 120_000,
  },
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-chat-browser-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    const transcript = join(
      root,
      'thread.jsonl',
    )
    const start = Date.UTC(
      2026,
      9,
      22,
      10,
    )
    const record = ({ index }: { index: number }) => JSON.stringify({
      type: index === 0 ? 'user' : 'assistant',
      timestamp: new Date(start + index * 1000).toISOString(),
      message: {
        content: [
          {
            type: 'text',
            text: `Checkpoint ${index}.`,
          },
        ],
      },
    }) + '\n'
    writeFileSync(
      transcript,
      Array.from(
        { length: 121 },
        (
          _,
          index,
        ) => record({ index }),
      ).join(''),
    )
    await commands.hydra([
      'create',
      'default',
    ])
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const native = decidePush({
          state: writer.state,
          key: 'native',
          newCardId: 'native',
          input: {
            title: 'Fixture agent',
            activity: 'finished',
            agent: {
              provider: 'claude',
              sessionId: 'chat-fixture',
              transcriptPath: transcript,
              cwd: root,
            },
          },
          meta: {
            actor: 'fixture',
            at: new Date(start - 3000).toISOString(),
          },
        })
        assert.ok('event' in native)
        writer.append({ event: native.event })
        const config = structuredClone(hydraConfig({ state: writer.state }))
        config.hydra.session = 'claude:chat-fixture'
        const configure = hydraEvent({
          state: writer.state,
          cardId: '$board',
          meta: {
            actor: 'web',
            at: new Date(start - 2500).toISOString(),
          },
          change: {
            type: 'board.configured',
            data: config,
          },
        })
        assert.ok('event' in configure)
        writer.append({ event: configure.event })
        const task = hydraEvent({
          state: writer.state,
          cardId: 'chat-ui-task',
          meta: {
            actor: 'hydra',
            at: new Date(start - 2000).toISOString(),
          },
          change: {
            type: 'task.created',
            data: {
              key: 'review',
              title: 'UI decision',
            },
          },
        })
        assert.ok('event' in task)
        writer.append({ event: task.event })
        const question = hydraEvent({
          state: writer.state,
          cardId: 'chat-ui-task',
          meta: {
            actor: 'hydra',
            at: new Date(start - 1000).toISOString(),
          },
          change: {
            type: 'task.asked',
            data: {
              id: 'old-question',
              audience: 'owner',
              question: 'Which scope?',
              options: [
                { label: 'Small scope' },
                { label: 'Full scope' },
              ],
            },
          },
        })
        assert.ok('event' in question)
        writer.append({ event: question.event })
        const report = hydraEvent({
          state: writer.state,
          cardId: 'chat-ui-task',
          meta: {
            actor: 'worker:chat-ui-task',
            at: new Date(start + 30_000).toISOString(),
          },
          change: {
            type: 'hydra.message',
            data: {
              task: 'chat-ui-task',
              hydra: 'hydra',
              action: 'send',
              text: 'Report body stays behind the closed row.',
            },
          },
        })
        assert.ok('event' in report)
        writer.append({ event: report.event })
      },
    })
    let server = await startServer({
      hydraId: 'default',
      port: 0,
      homes: [],
    })

    try {
      const url = `http://127.0.0.1:${server.port}/hydra/default/`
      const opened = await browser({
        args: ['run'],
        script: `
      await page.open(${JSON.stringify(url)});
      await page.wait('.waiting-decisions button');
      console.log(await page.eval(() => !document.querySelector('[data-entry-id="ask:chat-ui-task:old-question"]')));
      await page.click('.waiting-decisions [aria-haspopup="dialog"]');
      await page.wait('.waiting-decisions [role="dialog"] li button:not(:disabled)');
      await page.click('.waiting-decisions [role="dialog"] li button');
      await page.wait('[data-entry-id="ask:chat-ui-task:old-question"] .ask');
      console.log(await page.until(() => {
        const question=document.querySelector('[data-entry-id="ask:chat-ui-task:old-question"]');
        const scroller=document.querySelector('.hydra-messages');
        const card=question.getBoundingClientRect(), view=scroller.getBoundingClientRect();
        return card.top >= view.top && card.bottom <= view.bottom;
      }));
    `,
      })
      assert.deepEqual(
        opened.trim().split('\n'),
        [
          'true',
          'true',
        ],
      )
      const report = await browser({
        args: ['run'],
        script: `
      await page.click('.hydra-chat [data-task-ref="chat-ui-task"]');
      await page.wait('details.report-fold');
      console.log(await page.eval(() => {
        const report=document.querySelector('details.report-fold');
        return !report.open && !report.innerText.includes('Report body stays');
      }));
      await page.click('details.report-fold > summary');
      console.log(await page.eval(() => document.querySelector('details.report-fold').innerText.includes('Report body stays')));
      await page.click('[data-entry-id="ask:chat-ui-task:old-question"] [aria-label="Choose Small scope"]');
      await page.click('.hydra-chat .pending-decision-actions .button');
      await page.wait('.hydra-chat .chat-decision .decided');
      console.log(await page.eval(() => !document.querySelector('.waiting-decisions') && document.querySelector('.chat-decision .decided').textContent.includes('Decided')));
    `,
      })
      assert.deepEqual(
        report.trim().split('\n'),
        [
          'true',
          'true',
          'true',
        ],
      )
      const sourceAt = new Date(Date.now() - 1000).toISOString()
      withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          const question = hydraEvent({
            state: writer.state,
            cardId: 'chat-ui-task',
            meta: {
              actor: 'hydra',
              at: new Date(Date.now() - 2000).toISOString(),
            },
            change: {
              type: 'task.asked',
              data: {
                id: 'recorded-question',
                audience: 'owner',
                question: 'Start the focused repairs?',
              },
            },
          })
          assert.ok('event' in question)
          writer.append({ event: question.event })
          const source = hydraEvent({
            state: writer.state,
            cardId: 'chat-ui-task',
            meta: {
              actor: 'web',
              at: sourceAt,
              id: 'owner-source',
            },
            change: {
              type: 'hydra.message',
              data: {
                hydra: 'hydra',
                action: 'send',
                text: 'Sounds good',
              },
            },
          })
          assert.ok('event' in source)
          writer.append({ event: source.event })
        },
      })
      await commands.task([
        'answer',
        'chat-ui-task',
        'recorded-question',
        '--from-message',
        'owner-source',
        '--actor',
        'hydra',
        '--reason',
        'Owner answered in conversation',
      ])
      const recorded = await browser({
        args: ['run'],
        script: `
        await page.wait('[data-entry-id="ask:chat-ui-task:recorded-question"] .decided .button');
        console.log(await page.eval(() => document.querySelector('[data-entry-id="ask:chat-ui-task:recorded-question"]').textContent.includes('Recorded as your answer to')));
      `,
      })
      assert.equal(
        recorded.trim(),
        'true',
      )
      const evidence = process.env.PNYX_PR_EVIDENCE_DIR

      if (evidence) {
        mkdirSync(
          evidence,
          { recursive: true },
        )
        await browser({
          args: [
            'screenshot',
            join(
              evidence,
              'answer-recorded.png',
            ),
          ],
        })
      }

      const undone = await browser({
        args: ['run'],
        script: `
        await page.click('[data-entry-id="ask:chat-ui-task:recorded-question"] .decided .button');
        await page.wait('[data-entry-id="ask:chat-ui-task:recorded-question"] .ask');
        console.log(await page.eval(() => document.querySelector('[data-entry-id="ask:chat-ui-task:recorded-question"]').textContent.includes('Start the focused repairs?') && !document.querySelector('[data-entry-id="ask:chat-ui-task:recorded-question"] .decided')));
      `,
      })
      assert.equal(
        undone.trim(),
        'true',
      )

      if (evidence) {
        await browser({
          args: [
            'screenshot',
            join(
              evidence,
              'answer-reopened.png',
            ),
          ],
        })
      }

      appendFileSync(
        transcript,
        Array.from(
          { length: 20 },
          (
            _,
            offset,
          ) => record({ index: 121 + offset }),
        ).join(''),
      )
      const advanced = await browser({
        args: ['run'],
        script: `
      await page.until(() => document.querySelector('.hydra-chat .messages').textContent.includes('Checkpoint 140.'));
      console.log(await page.eval(() => document.querySelector('.hydra-chat .messages').textContent.includes('Checkpoint 80.')));
    `,
      })
      assert.equal(
        advanced.trim(),
        'true',
      )
      const port = server.port
      await server.close()
      server = await startServer({
        hydraId: 'default',
        port,
        homes: [],
      })
      appendFileSync(
        transcript,
        record({ index: 141 }),
      )
      const reconnected = await browser({
        args: ['run'],
        script: `
      await page.until(() => document.querySelector('.hydra-chat .messages').textContent.includes('Checkpoint 141.'));
      console.log(await page.eval(() => {
        const text=document.querySelector('.hydra-chat .messages').textContent;
        return text.includes('Checkpoint 141.') && text.includes('Checkpoint 80.');
      }));
    `,
      })
      assert.equal(
        reconnected.trim(),
        'true',
      )
    } finally {
      try {
        await browser({ args: ['stop'] })
      } finally {
        await server.close()
      }
    }
  },
)
