import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserFixture } from '../src/test-harness/browser-fixture.ts'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/app/server-daemon.ts'
import { loadHydra } from '../src/app/store.ts'

const browser = browserFixture()

test(
  'task titles toggle immediately and edit explicitly with save and cancel',
  {
    timeout: 120_000,
  },
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-title-browser-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    process.env.PNYX_SEMANTIC = 'off'
    await commands.hydra([
      'create',
      'default',
    ])
    await commands.task([
      'create',
      '--title',
      'First title',
      '--key',
      'first',
    ])
    await commands.task([
      'create',
      '--title',
      'Second title',
      '--key',
      'second',
    ])
    const server = await startServer({
      hydraId: 'default',
      port: 0,
      homes: [],
    })
    const firstId = loadHydra({ hydraId: 'default' }).state.keys.first!
    const firstSelector = `[data-card="${firstId}"]`
    let closed = false

    try {
      const output = await browser({
        args: ['run'],
        script: `
        await page.open('http://127.0.0.1:${server.port}/hydra/default/');
        await page.wait('.card [aria-label="Edit task title"]:not(:disabled)');
        await page.click('[aria-label="Open task First title"]');
        await page.until(() => document.querySelector(${JSON.stringify(firstSelector)}).getAttribute('aria-expanded') === 'true');
        await page.click('[aria-label="Open task First title"]');
        await page.until(() => document.querySelector(${JSON.stringify(firstSelector)}).getAttribute('aria-expanded') === 'false');
        await page.click('[aria-label="Open task First title"]');
        await page.until(() => document.querySelector(${JSON.stringify(firstSelector)}).getAttribute('aria-expanded') === 'true');
        await page.click('[aria-label="Open task Second title"]');
        await page.until(() => document.querySelector('[aria-label="Open task Second title"]').getAttribute('aria-expanded') === 'true'
          && document.querySelector(${JSON.stringify(firstSelector)}).getAttribute('aria-expanded') === 'false');
        await page.eval(() => document.querySelector(${JSON.stringify(firstSelector)}).closest('.card').querySelector('[aria-label="Edit task title"]').click());
        await page.until(() => {
          const first = document.querySelector(${JSON.stringify(firstSelector)}), card = first.closest('.card');
          return first.isContentEditable && !card.draggable && first.getAttribute('aria-expanded') !== 'true' && document.activeElement === first;
        });
        await page.eval(() => {
          const first = document.querySelector(${JSON.stringify(firstSelector)});
          first.textContent = 'Cancelled';
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await page.until(() => {
          const first = document.querySelector(${JSON.stringify(firstSelector)});
          return first.textContent === 'First title' && !first.isContentEditable && first.closest('.card').draggable;
        });
        console.log(await page.eval(async () => {
          const first = document.querySelector(${JSON.stringify(firstSelector)}), card = first.closest('.card');
          const button = card.querySelector('[aria-label="Edit task title"]');
          const blockedDrag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
          button.dispatchEvent(blockedDrag);
          if (!blockedDrag.defaultPrevented || blockedDrag.dataTransfer.getData('application/pnyx-task')) throw new Error('button drag accepted');
          const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
          card.dispatchEvent(drag);
          if (drag.defaultPrevented || !drag.dataTransfer.getData('application/pnyx-task')) throw new Error('ordinary drag rejected');
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
          first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          await new Promise(resolve => queueMicrotask(resolve));
          if (first.isContentEditable) throw new Error('double click edits');
          return true;
        }));
        await page.eval(() => document.querySelector(${JSON.stringify(firstSelector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
        await page.until(() => document.querySelector(${JSON.stringify(firstSelector)}).isContentEditable);
        await page.eval(() => {
          const first = document.querySelector(${JSON.stringify(firstSelector)});
          first.textContent = 'Saved title';
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await page.wait('[aria-label="Open task Saved title"]');
        console.log(await page.eval(() => {
          const title = document.querySelector(${JSON.stringify(firstSelector)});
          return !title.isContentEditable && title.textContent === 'Saved title';
        }));
        await page.eval(() => document.querySelector(${JSON.stringify(firstSelector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
        await page.until(() => document.querySelector(${JSON.stringify(firstSelector)}).isContentEditable);
        await page.eval(() => {
          const title = document.querySelector(${JSON.stringify(firstSelector)});
          title.textContent = '   ';
          title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        console.log(await page.until(() => {
          const title = document.querySelector(${JSON.stringify(firstSelector)});
          return title.textContent === 'Saved title' && !title.isContentEditable;
        }));
        await page.eval(() => document.querySelector(${JSON.stringify(firstSelector)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
        await page.until(() => document.querySelector(${JSON.stringify(firstSelector)}).isContentEditable);
        await page.eval(() => {
          const title = document.querySelector(${JSON.stringify(firstSelector)});
          title.textContent = 'Blur title';
          title.blur();
        });
        await page.wait('[aria-label="Open task Blur title"]');
        `,
      })
      assert.deepEqual(
        output.trim().split('\n'),
        [
          'true',
          'true',
          'true',
        ],
      )
      await server.close()
      closed = true
      const disconnected = await browser({
        args: ['run'],
        script: `
        await page.wait('.card [aria-label="Edit task title"]:disabled');
        console.log(await page.eval(async () => {
          const title = document.querySelector('[aria-label="Open task Blur title"]');
          title.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
          await new Promise(resolve => queueMicrotask(resolve));
          return !title.isContentEditable;
        }));
        `,
      })
      assert.equal(
        disconnected.trim(),
        'true',
      )
    } finally {
      try {
        await browser({ args: ['stop'] })
      } finally {
        if (!closed) {
          await server.close()
        }
      }
    }
  },
)
