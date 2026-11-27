import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterAll } from 'vitest'

const require = createRequire(import.meta.url)
const cli = join(
  dirname(require.resolve('chrome-devtools-axi/package.json')),
  'dist/bin/chrome-devtools-axi.js',
)
const mcp = join(
  dirname(require.resolve('chrome-devtools-mcp/package.json')),
  'out/Default/gen/src/bin/chrome-devtools-mcp.js',
)
const server = createServer()
await new Promise<void>(resolve => server.listen(
  0,
  '127.0.0.1',
  resolve,
))
const port = (server.address() as { port: number }).port
await new Promise<void>(resolve => server.close(() => resolve()))
const env = {
  ...process.env,
  CHROME_DEVTOOLS_AXI_PORT: String(port),
  CHROME_DEVTOOLS_AXI_SESSION: `status-${port}`,
  CHROME_DEVTOOLS_AXI_MCP_PATH: mcp,
  CHROME_DEVTOOLS_AXI_HEADED: '0',
  CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--use-mock-keychain --password-store=basic',
}

export function chrome({
  args = ['run'],
  script,
}: {
  args?: string[]
  script?: string
}): Promise<string> {
  return new Promise((
    resolve,
    reject,
  ) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        ...args,
      ],
      { env },
    )
    let output = ''
    let errors = ''
    child.stdout.on(
      'data',
      chunk => output += String(chunk),
    )
    child.stderr.on(
      'data',
      chunk => errors += String(chunk),
    )
    child.on(
      'error',
      reject,
    )
    child.on(
      'close',
      code => code === 0 ? resolve(output.trim()) : reject(new Error(`${output}\n${errors}`)),
    )
    child.stdin.end(script)
  })
}

afterAll(async () => {
  await chrome({ args: ['stop'] })
})

export const fillComposer = ({
  selector,
  text,
}: {
  selector: string
  text: string
}) => `await page.eval(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  field.focus();
  getSelection().selectAllChildren(field);
  document.execCommand(${JSON.stringify(text ? 'insertText' : 'delete')}, false, ${JSON.stringify(text)});
});`
