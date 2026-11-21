import { spawn } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI, parsed, pnyx, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'

let app: Pnyx
let hydra: Hydra
const env = () => ({ ...process.env })
const run = ({ args }: { args: string[] }) => pnyx({
  args: [
    ...args,
    '--hydra',
    hydra.id,
  ],
  env: env(),
})

beforeAll(async () => {
  app = await startPnyx()
  hydra = await app.hydra()
})

describe(
  'plain CLI',
  () => {
    it(
      'prints plain help and an optional JSON version without requiring a server',
      async () => {
        const help = await pnyx({
          args: ['--help'],
          env: env(),
        })
        expect(help.status).toBe(0)
        expect(help.stdout).toContain('usage: pnyx')
        expect(help.stdout).toContain('worker.log')
        expect(help.stdout).not.toContain('help[')
        const version = await pnyx({
          args: [
            '--version',
            '--json',
          ],
          env: env(),
        })
        expect(parsed(version).version).toMatch(/^\d+\.\d+\.\d+/)
      },
    )

    it(
      'creates and starts a task once, messages its worker and prints a plain Hydra',
      async () => {
        const folder = hydra.folder({ name: 'plain-cli-worker' })
        const args = [
          'task',
          'create',
          '--title',
          'Plain CLI task',
          '--brief',
          'Check the requested behavior',
          '--folder',
          folder,
          '--harness',
          'claude',
          '--key',
          'plain-cli-public',
          '--event-id',
          'plain-create',
          '--json',
        ]
        const first = await run({ args })
        expect(first.status).toBe(0)
        const receipt = parsed(first)
        expect(receipt).toMatchObject({
          launch: 'started',
          task: expect.any(String),
        })
        expect(receipt).not.toHaveProperty('help')
        await hydra.owner({
          args: [
            'push',
            '--key',
            'plain-cli-public',
            '--file',
            '-',
          ],
          input: JSON.stringify({ settings: { help: 'Keep this user setting' } }),
        })
        const stored = await run({
          args: [
            'task',
            'show',
            receipt.task,
            '--full',
            '--json',
          ],
        })
        expect(parsed(stored).task.settings.help).toBe('Keep this user setting')
        expect((await run({
          args: [
            'task',
            'show',
            receipt.task,
            '--full',
          ],
        })).stdout).toContain('Keep this user setting')
        const worker = await hydra.agent({ cwd: folder })
        expect(parsed(await run({ args })).task).toBe(receipt.task)
        expect(app.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)

        const message = join(
          folder,
          'message.txt',
        )
        writeFileSync(
          message,
          'Check the file input too',
        )
        const sent = await run({
          args: [
            'send',
            '--task',
            receipt.task,
            '--file',
            message,
            '--idempotency-key',
            'plain-send',
            '--json',
          ],
        })
        expect(sent.status).toBe(0)
        expect(parsed(sent).reply.card).toBe(receipt.task)
        await until({
          what: 'the message to reach the worker',
          check: () => worker.received.some(text => text.includes(readFileSync(
            message,
            'utf8',
          ))),
        })
        await run({
          args: [
            'send',
            '--task',
            receipt.task,
            '--file',
            message,
            '--idempotency-key',
            'plain-send',
            '--json',
          ],
        })
        expect(worker.received.filter(text => text.includes('Check the file input too'))).toHaveLength(1)

        const board = await run({ args: ['board'] })
        expect(board.status).toBe(0)
        expect(board.stdout).toContain('Plain CLI task')
        expect(board.stdout).not.toContain('help[')
        expect(parsed(await run({
          args: [
            'board',
            '--json',
          ],
        })).hydraId).toBe(hydra.id)

        const historyArgs = [
          'history',
          '--limit',
          '1',
          '--json',
        ]
        const latest = parsed(await run({ args: historyArgs }))
        expect(latest.next).toBe(latest.events[0].seq)
        const older = parsed(await run({
          args: [
            ...historyArgs,
            '--before',
            String(latest.next),
          ],
        }))
        expect(older.events[0].seq).toBeLessThan(latest.next)
      },
    )

    it(
      'sends to Hydra and answers a task question',
      async () => {
        const sent = await run({
          args: [
            'send',
            '--text',
            'Review these tasks',
            '--json',
          ],
        })
        expect(sent.status).toBe(0)
        expect(parsed(sent).message).toEqual(expect.any(String))
        const session = await hydra.agent({ hydra: true })
        await until({
          what: 'Hydra to receive the CLI message',
          check: () => session.received.some(text => text.includes('Review these tasks')),
        })
        const { worker } = await hydra.startTask({ key: 'plain-question' })
        const question = await hydra.as({ session: worker }).run({
          args: [
            'task',
            'ask',
            'plain-question',
            '--question',
            'Which value?',
            '--to',
            'owner',
          ],
        })
        const answer = await run({
          args: [
            'answer',
            'plain-question',
            question.ask,
            '--text',
            'Use the existing value',
            '--json',
          ],
        })
        expect(
          answer.status,
          answer.stderr,
        ).toBe(0)
        expect(parsed(answer)).toMatchObject({ state: expect.any(String) })
        await until({
          what: 'the worker to receive the answer',
          check: () => worker.received.some(text => text.includes('Use the existing value')),
        })
      },
    )

    it(
      'prints a JSON startup receipt when serving an isolated home',
      async ({ onTestFinished }) => {
        const child = spawn(
          process.execPath,
          [
            CLI,
            'serve',
            '--port',
            '0',
            '--json',
          ],
          {
            env: {
              ...env(),
              PNYX_HOME: hydra.folder({ name: 'cli-serve-home' }),
            },
          },
        )
        let stdout = '', stderr = ''
        child.stdout.on(
          'data',
          chunk => stdout += String(chunk),
        )
        child.stderr.on(
          'data',
          chunk => stderr += String(chunk),
        )
        onTestFinished(async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
          }

          await until({
            what: 'the scratch server to stop',
            check: () => child.exitCode !== null || child.signalCode !== null,
          })
        })
        const line = await until({
          what: 'the scratch server startup receipt',
          check: () => {
            if (child.exitCode !== null) {
              throw new Error(stderr)
            }

            return stdout.includes('\n') && stdout.split('\n')[0]
          },
        })
        expect(JSON.parse(line)).toMatchObject({
          server: 'running',
          url: expect.stringMatching(/^http:/),
        })
      },
    )

    it(
      'rejects removed commands and unknown flags without hint output',
      async () => {
        for (const args of [
          [
            'task',
            'rename',
            'anything',
            '--title',
            'Changed',
          ],
          ['report'],
          ['toString'],
          [
            'hydra',
            'usage',
            'refresh',
          ],
          [
            'send',
            '--task=',
            '--text',
            'This must stay out of Hydra chat',
          ],
          [
            'board',
            '--json=false',
          ],
          [
            'send',
            '--text',
            'Unexpected revision',
            '--if-revision',
            '1',
          ],
          [
            'board',
            '--full',
          ],
        ]) {
          const refused = await run({
            args: [
              ...args,
              '--json',
            ],
          })
          expect(refused.status).toBe(2)
          expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'VALIDATION_ERROR' })
          expect(refused.stdout).toBe('')
          expect(refused.stderr).not.toContain('help[')
        }

        const literal = await run({
          args: [
            'send',
            '--text=--json',
            '--json',
          ],
        })
        expect(literal.status).toBe(0)
      },
    )
  },
)
