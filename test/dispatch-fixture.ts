import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath, writeConfig } from '../src/dispatch/config.ts'

export function fakeDispatch({ root, hydraId = 'lab' }: { root: string; hydraId?: string }) {
  const bin = join(root, 'fake-bin')
  const claude = join(root, 'claude'), codex = join(root, 'codex')

  for (const folder of [bin, claude, codex]) {
    mkdirSync(folder, { recursive: true })
  }

  const command = join(bin, 'quota-axi')
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const provider = process.argv[process.argv.indexOf('--provider') + 1];
const folder = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const fixture = path.join(folder, 'quota.json');
const data = fs.existsSync(fixture) ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : {};
if (process.argv.includes('models')) console.log(JSON.stringify(data.models ? {models: data.models} : {}));
else console.log(JSON.stringify({providers: [{provider, state: {status: 'fresh', authStatus: 'usable'}, ...data.provider}]}));
`)
  chmodSync(command, 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  writeConfig({ path: configPath({ hydraId, accounts: true, shared: true }), accounts: true, value: { accounts: { 'claude:test': { provider: 'claude', folder: claude }, 'codex:test': { provider: 'codex', folder: codex } } } })
  writeConfig({ path: configPath({ hydraId, shared: true }), value: { main: 'claude:test', workers: { claude: ['claude:test'], codex: ['codex:test'] } } })

  return { bin, claude, codex }
}
