// Manual check of semantic search on the real models: pnpm test:semantic.
// Downloads the pinned files (about 1.1 GB) into a disposable Pnyx home, or links
// them from PNYX_GOLDEN_MODELS, a folder already holding them. Setup checks each
// model against its golden values; this then checks that both embedders find
// cards across languages and by paraphrase, and prints warm search times.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMBEDDERS, RERANKER } from '../src/search/models.ts'

const BIN = join(import.meta.dirname, '..', 'dist', 'cli', 'pnyx-axi.js')
const home = mkdtempSync(join(tmpdir(), 'pnyx-golden-'))
const env = { ...process.env, PNYX_HOME: home, PNYX_SEMANTIC_STUB: '' }
const run = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const cards = (out: string) => [...out.matchAll(/^ {2}- card: (\S+)$/gm)].map(m => m[1])

const from = process.env.PNYX_GOLDEN_MODELS

if (from) {
  mkdirSync(join(home, 'models'))

  for (const m of [...Object.values(EMBEDDERS), RERANKER]) {
    if (existsSync(join(from, m.file))) {
      linkSync(join(from, m.file), join(home, 'models', m.file))
    }
  }
}

const CARDS: [string, string][] = [
  ['Orders migration', 'The deploy was reverted after the migration locked the orders table.'],
  ['Checkout flake', 'O teste do checkout falha às vezes por causa de uma condição de corrida.'],
  ['Theme', 'Added a dark mode toggle to the settings page.'],
  ['Rate limits', 'The API answers HTTP 429 when a client sends too many requests.'],
  ['Mobile e2e', 'O emulador Android ficou sem memória e o teste e2e travou.'],
]
const ids = CARDS.map(([title, note], i) => {
  writeFileSync(join(home, 'card.json'), JSON.stringify({ title }))
  const id = run('push', '--key', `k${i}`, '--file', join(home, 'card.json')).match(/^card:\n {2}id: (\S+)$/m)![1]!
  run('outcome', id, 'done', '--note', note)

  return id
})

// Query, then the card (by CARDS index) it must rank first: across languages and by paraphrase.
const QUERIES: [string, string][] = [
  ['rollback after a database schema change blocked writes', ids[0]!],
  ['intermittent test failure caused by timing', ids[1]!],
  ['preferência de tema com cores escuras', ids[2]!],
  ['throttling de requisições', ids[3]!],
  ['phone emulator out of RAM', ids[4]!],
]

async function embedded(): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const m = run('search', 'status').match(/^vectors: (\d+) of (\d+) entries embedded$/m)

    if (m && m[1] === m[2]) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 200))
  }

  throw new Error('the worker never finished embedding')
}

function check(label: string): void {
  for (const [q, card] of QUERIES) {
    assert.equal(cards(run('search', q))[0], card, `${label}: ${q}`)
  }

  const times: number[] = []

  for (let i = 0; i < 5; i += 1) {
    const t = performance.now()
    run('search', QUERIES[i]![0])
    times.push(performance.now() - t)
  }

  times.sort((a, b) => a - b)
  console.log(`${label}: ${QUERIES.length}/${QUERIES.length} ranked first; warm search p50 ${times[2]!.toFixed(0)} ms (CLI process included)`)
}

try {
  const setup = run('search', 'setup', '--semantic')
  console.log(setup.match(/^mode: .*$/m)![0])
  await embedded()
  console.log(run('search', 'status').match(/^semantic: .*$/m)![0])
  check(`default model, reranker ${/^rerank: on$/m.test(setup) ? 'on' : 'off'}`)
  run('settings', 'set', 'search.rerank', 'off')
  check('default model, reranker off')
  run('search', 'setup', '--semantic', '--model', 'granite-97m', '--no-rerank')
  await embedded()
  check('granite-97m')
  console.log('golden check passed')
} finally {
  run('settings', 'set', 'search.semantic', 'off')
}
