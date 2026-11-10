import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Evaluate = ({ script }: { script: string }) => Promise<void>

const probe = readFileSync(
  join(
    import.meta.dirname,
    'fixtures',
    'chat-contract.js',
  ),
  'utf8',
)

export async function installChatContract({
  evaluate,
  marker,
  expected,
}: {
  evaluate: Evaluate
  marker: string
  expected?: string
}) {
  await evaluate({
    script: `() => {
      window.chatContract = (${probe})(${JSON.stringify({
        marker,
        expected,
      })});
      return 'chat-assertion-passed';
    }`,
  })
}

export async function assertChatContract({
  evaluate,
  expected,
  finish = false,
}: {
  evaluate: Evaluate
  expected: string
  finish?: boolean
}) {
  assert.ok(expected.length > 0)
  await evaluate({
    script: `async () => {
      const proof = await window.chatContract.waitFor(${JSON.stringify({
        wanted: expected,
        finish,
      })});
      return 'chat-assertion-passed ' + JSON.stringify(proof);
    }`,
  })
}
