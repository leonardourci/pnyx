import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function smokeEnvironment(
  { session }: { session: string },
): Promise<NodeJS.ProcessEnv> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  await promisify(probe.close.bind(probe))()

  if (!address || typeof address === 'string') {
    throw new Error('No private browser port was allocated')
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHROME_DEVTOOLS_AXI_SESSION: `${session}-${process.pid}-${randomUUID().slice(0, 8)}`,
    CHROME_DEVTOOLS_AXI_PORT: String(address.port),
  }

  for (const key of ['AUTO_CONNECT', 'HEADED', 'BROWSER_URL', 'USER_DATA_DIR', 'MCP_SERVER_URL', 'WS_HEADERS', 'CHROME_ARGS']) {
    delete env[`CHROME_DEVTOOLS_AXI_${key}`]
  }

  return env
}

export function smokeBrowser({ home, session }: { home: string; session: string }) {
  const environment = smokeEnvironment({ session })
  const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
  mkdirSync(evidence, { recursive: true })

  const browser = async ({ args }: { args: string[] }) => {
    const { stdout } = await exec('chrome-devtools-axi', args, { env: await environment, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
    assert.doesNotMatch(stdout, /^error:/m)

    return stdout
  }

  const evaluate = ({ code }: { code: string }) => browser({ args: ['eval', `async () => { ${code} }`] })

  const check = async ({ condition, label }: { condition: string; label: string }) => {
    await evaluate({ code: `if (!(${condition})) throw new Error(${JSON.stringify(label)}); return 'passed';` })
    process.stdout.write(`Passed: ${label}\n`)
  }

  const eventually = ({ condition, label }: { condition: string; label: string }) => evaluate({ code: `for (let i = 0; i < 100; i++) { if (${condition}) return true; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(${JSON.stringify(label)});` })
  const click = ({ selector }: { selector: string }) => evaluate({ code: `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing ${selector.replaceAll("'", '')}'); el.click(); return true;` })
  const text = ({ label }: { label: string }) => evaluate({ code: `const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!el) throw new Error('Missing button'); el.click(); return true;` })
  const fill = ({ label, value }: { label: string; value: string }) => evaluate({ code: `const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true;` })
  const press = ({ key }: { key: string }) => browser({ args: ['press', key] })
  const focus = ({ selector }: { selector: string }) => evaluate({ code: `document.querySelector(${JSON.stringify(selector)}).focus(); return true;` })

  const drag = async ({ selector, dy }: { selector: string; dy: number }) => {
    await evaluate({ code: `const handle = document.querySelector(${JSON.stringify(selector)}); handle.scrollIntoView({ block: 'nearest' }); handle.dataset.smokeLabel = handle.getAttribute('aria-label'); handle.setAttribute('aria-label', 'Smoke drag handle'); const rect = handle.getBoundingClientRect(); const target = document.createElement('button'); target.id = 'smoke-drag-target'; target.textContent = 'Smoke drag target'; Object.assign(target.style, { position: 'fixed', left: (rect.left + rect.width / 2 - 2) + 'px', top: (rect.top + rect.height / 2 + ${dy} - 2) + 'px', width: '4px', height: '4px', padding: '0', overflow: 'hidden', zIndex: '9999' }); document.body.append(target); return true;` })

    try {
      const snapshot = await browser({ args: ['snapshot', '--full'] })
      const from = snapshot.match(/uid=(\S+) separator "Smoke drag handle"/)
      const to = snapshot.match(/uid=(\S+) button "Smoke drag target"/)
      assert.ok(from && to, snapshot)
      await browser({ args: ['drag', `@${from[1]}`, `@${to[1]}`] })
    } finally {
      await evaluate({ code: 'document.querySelector(\'#smoke-drag-target\')?.remove(); const handle = document.querySelector(\'[data-smoke-label]\'); if (handle) { handle.setAttribute(\'aria-label\', handle.dataset.smokeLabel); delete handle.dataset.smokeLabel; } return true;' })
    }
  }

  const screenshot = async ({ name }: { name: string }) => {
    const path = join(evidence, name); rmSync(path, { force: true })

    try {
      await browser({ args: ['screenshot', path] })
    } catch (error) {
      if (!existsSync(path) || readFileSync(path).subarray(0, 8)
        .toString('hex') !== '89504e470d0a1a0a') {
        throw error
      }
    }
  }

  const close = () => browser({ args: ['stop'] }).catch(() => {})

  return {
    browser, evaluate, check, eventually, click, text, fill, press, focus, drag, screenshot, close,
  }
}
