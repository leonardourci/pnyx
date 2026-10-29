import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { materializePolicy } from '#workers/native-policy-files.ts'
import { policyDigest, toolCeiling, type NativePolicy } from '#workers/native-policy.ts'

const COMMAND_MS = 10000

test(
  'the native policy denies sibling reads, readonly writes, TCP and unrelated sockets while permitting private work and its broker',
  { skip: process.platform !== 'darwin' },
  async t => {
    const root = realpathSync(mkdtempSync('/tmp/pnyx-policy-'))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = join(
      root,
      'home',
    )
    t.after(() => {
      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    const workspace = join(
      root,
      'work',
    )
    mkdirSync(workspace)
    const canary = join(
      root,
      'owner-credential',
    )
    writeFileSync(
      canary,
      'synthetic-owner-secret',
    )
    const socket = join(
      root,
      'broker.sock',
    )
    const broker = createServer(peer => peer.end('scoped-broker'))
    await new Promise<void>(resolve => broker.listen(
      socket,
      resolve,
    ))
    t.after(() => new Promise<void>(resolve => broker.close(() => resolve())))

    const compile = ({ writable }: { writable: boolean }): NativePolicy => {
      const resolved = {
        grant: 'fixture',
        revision: writable ? 2 : 1,
        readRoots: [
          workspace,
          '/bin',
          '/usr',
          '/System',
          '/dev',
          '/opt/homebrew',
          '/Library/Apple',
          '/private/var/db',
        ],
        writeRoots: writable ? [workspace] : [],
        brokerSocket: socket,
        environment: {
          PATH: '/usr/bin:/bin',
          HOME: workspace,
          TMPDIR: workspace,
        },
      }

      return {
        ...resolved,
        digest: policyDigest({ policy: resolved }),
      }
    }

    const run = ({
      policy,
      script,
    }: {
      policy: NativePolicy
      script: string
    }) => {
      const home = materializePolicy({ policy })

      return execFileSync(
        'codex',
        [
          'sandbox',
          '-P',
          'pnyx-task',
          '--allow-unix-socket',
          socket,
          '--',
          '/bin/sh',
          '-c',
          script,
        ],
        {
          cwd: workspace,
          env: {
            PATH: process.env.PATH,
            CODEX_HOME: home,
            HOME: workspace,
          },
          encoding: 'utf8',
          timeout: COMMAND_MS,
          stdio: [
            'ignore',
            'pipe',
            'pipe',
          ],
        },
      )
    }

    const readonly = compile({ writable: false })
    assert.throws(() => run({
      policy: readonly,
      script: `cat '${canary}'`,
    }))
    assert.throws(() => run({
      policy: readonly,
      script: 'printf forbidden > readonly-marker',
    }))
    assert.equal(
      existsSync(join(
        workspace,
        'readonly-marker',
      )),
      false,
    )
    const local = compile({ writable: true })
    assert.equal(
      run({
        policy: local,
        script: 'printf local > build-result; cat build-result',
      }),
      'local',
    )
    assert.throws(() => run({
      policy: local,
      script: `printf forbidden > '${join(
        root,
        'foreign-ref',
      )}'`,
    }))
    const denied = toolCeiling({
      policy: local,
      tool: 'mcp__github__comment',
      input: {},
    })
    assert.equal(
      denied.allowed,
      false,
    )
    assert.equal(
      toolCeiling({
        policy: local,
        tool: 'Agent',
        input: {},
      }).allowed,
      false,
    )
    assert.equal(
      toolCeiling({
        policy: local,
        tool: 'Write',
        input: { file_path: canary },
      }).allowed,
      false,
    )
    const wrapped = toolCeiling({
      policy: readonly,
      tool: 'Bash',
      input: { command: `cat '${canary}'` },
    })
    assert.ok(wrapped.allowed)
    assert.throws(() => execFileSync(
      '/bin/sh',
      [
        '-c',
        String(wrapped.input.command),
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        timeout: COMMAND_MS,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    ))
    const child = spawn(
      'codex',
      [
        'sandbox',
        '-P',
        'pnyx-task',
        '--allow-unix-socket',
        socket,
        '--',
        process.execPath,
        '-e',
        `const net=require('node:net'); const s=net.createConnection(${JSON.stringify(socket)}); s.on('data',b=>process.stdout.write(b)); s.on('error',()=>process.exit(2))`,
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          CODEX_HOME: materializePolicy({ policy: local }),
          HOME: workspace,
        },
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      },
    )
    let reply = ''
    child.stdout.on(
      'data',
      chunk => {
        reply += chunk
      },
    )
    const deadline = setTimeout(
      () => child.kill('SIGKILL'),
      COMMAND_MS,
    )
    const code = await new Promise<number | null>((
      resolve,
      reject,
    ) => {
      child.once(
        'exit',
        resolve,
      ); child.once(
        'error',
        reject,
      )
    })
    clearTimeout(deadline)
    assert.equal(
      code,
      0,
    )
    assert.equal(
      reply,
      'scoped-broker',
    )
  },
)
