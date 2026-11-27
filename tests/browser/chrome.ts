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
  // A wide window, so the page opens in its wide layout rather than the phone one.
  CHROME_DEVTOOLS_AXI_CHROME_ARGS: '--use-mock-keychain --password-store=basic --window-size=1440,900',
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
