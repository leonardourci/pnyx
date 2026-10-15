import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export function smokeBrowser({ home, session }: { home: string; session: string }) {
  const env = {
    ...process.env,
    CHROME_DEVTOOLS_AXI_SESSION: `${session}-${process.pid}`,
    CHROME_DEVTOOLS_AXI_PORT: String(20000 + process.pid % 30000),
    CHROME_DEVTOOLS_AXI_AUTO_CONNECT: '0',
    CHROME_DEVTOOLS_AXI_HEADED: '0',
  }

  for (const name of ['CHROME_DEVTOOLS_AXI_BROWSER_URL', 'CHROME_DEVTOOLS_AXI_USER_DATA_DIR', 'CHROME_DEVTOOLS_AXI_MCP_SERVER_URL', 'CHROME_DEVTOOLS_AXI_WS_HEADERS', 'CHROME_DEVTOOLS_AXI_CHROME_ARGS']) {
    delete (env as NodeJS.ProcessEnv)[name]
  }

  const evidence = process.env.PNYX_EVIDENCE_DIR ?? join(home, 'evidence')
  mkdirSync(evidence, { recursive: true })

  const browser = async ({ args }: { args: string[] }) => {
    const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })
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
    browser, evaluate, check, eventually, click, text, fill, press, focus, screenshot, close,
  }
}
