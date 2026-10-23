import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'

async function freePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(
    0,
    '127.0.0.1',
    resolve,
  ))
  const address = listener.address()
  assert.ok(address && typeof address === 'object')
  await promisify(listener.close.bind(listener))()

  return address.port
}

test(
  'task titles toggle immediately and edit explicitly with save and cancel',
  {
    skip: process.env.PNYX_BROWSER_TESTS !== '1',
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
    const port = await freePort()
    const env = {
      ...process.env,
      CHROME_DEVTOOLS_AXI_SESSION: `pnyx-title-test-${port}`,
      CHROME_DEVTOOLS_AXI_PORT: String(port),
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '',
      CHROME_DEVTOOLS_AXI_HEADED: '0',
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: join(
        root,
        'chrome',
      ),
    }

    const browser = async ({
      args,
      script,
    }: {
      args: string[]
      script?: string
    }) => {
      const child = execFile(
        'chrome-devtools-axi',
        args,
        {
          env,
          timeout: 60_000,
        },
      )
      const result = new Promise<string>((
        resolve,
        reject,
      ) => {
        let output = ''
        let errors = ''
        child.stdout?.on(
          'data',
          text => {
            output += text
          },
        )
        child.stderr?.on(
          'data',
          text => {
            errors += text
          },
        )
        child.on(
          'error',
          reject,
        )
        child.on(
          'close',
          code => {
            if (code !== 0) {
              reject(new Error(errors || output))

              return
            }

            resolve(output)
          },
        )
      })
      child.stdin?.end(script)

      return await result
    }

    let closed = false

    try {
      const output = await browser({
        args: ['run'],
        script: `
        await page.open('http://127.0.0.1:${server.port}/hydra/default/');
        await page.wait('.card [aria-label="Edit task title"]:not(:disabled)');
        console.log(await page.eval(async () => {
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const title = name => Array.from(document.querySelectorAll('.card-open')).find(item => item.textContent === name);
          const first = title('First title');
          const second = title('Second title');
          const check = (ok, message) => { if (!ok) throw new Error(message); };
          const click = item => item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
          const selected = item => item.getAttribute('aria-expanded') === 'true';
          const until = async check => {
            const started = performance.now();
            while (!check() && performance.now() - started < 300) await frame();
          };
          click(first); await until(() => selected(first));
          check(selected(first), 'first opens');
          click(first); await until(() => !selected(first));
          check(!selected(first), 'first closes without rename delay');
          click(first); await frame(); await frame();
          click(second); await until(() => selected(second));
          check(!selected(first) && selected(second), 'one open per column immediately');
          const card = first.closest('.card');
          card.querySelector('[aria-label="Edit task title"]').click();
          await frame(); await frame();
          check(first.isContentEditable && !card.draggable && !selected(first), 'pencil edits closed card without opening');
          check(document.activeElement === first, 'edit focuses title');
          first.textContent = 'Cancelled';
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await frame();
          check(first.textContent === 'First title' && !first.isContentEditable && card.draggable, 'Escape restores title and dragging');
          const button = card.querySelector('[aria-label="Edit task title"]');
          const blockedDrag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
          button.dispatchEvent(blockedDrag);
          check(blockedDrag.defaultPrevented && !blockedDrag.dataTransfer.getData('application/pnyx-task'), 'button drag rejected');
          const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
          card.dispatchEvent(drag);
          check(!drag.defaultPrevented && drag.dataTransfer.getData('application/pnyx-task'), 'ordinary card drag allowed');
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
          first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          await frame();
          check(!first.isContentEditable, 'double click does not edit');
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
          await frame(); await frame();
          check(first.isContentEditable, 'F2 edits');
          first.textContent = 'Saved title';
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        }));
        await page.wait('[aria-label="Open task Saved title"]');
        console.log(await page.eval(() => {
          const title = document.querySelector('[aria-label="Open task Saved title"]');
          return !title.isContentEditable && title.textContent === 'Saved title';
        }));
        console.log(await page.eval(async () => {
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          const title = document.querySelector('[aria-label="Open task Saved title"]');
          const edit = async () => {
            title.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
            await frame(); await frame();
          };
          await edit();
          title.textContent = '   ';
          title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await frame();
          if (title.textContent !== 'Saved title') throw new Error('empty title changed saved value');
          await edit();
          title.textContent = 'Blur title';
          title.blur();
          return true;
        }));
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
        console.log(await page.eval(() => {
          const title = document.querySelector('[aria-label="Open task Blur title"]');
          title.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
          return !title.isContentEditable;
        }));
        `,
      })
      assert.equal(
        disconnected.trim(),
        'true',
      )
    } finally {
      await browser({ args: ['stop'] })

      if (!closed) {
        await server.close()
      }
    }
  },
)
