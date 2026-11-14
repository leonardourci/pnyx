import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexProvider } from './codex.ts'
import { replayCodex } from '#test-harness/fake-agents.ts'
import { claudeProvider } from './claude.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { inbox } from '#hydra/update-queue.ts'
import { until } from '#test-harness/harness.ts'
import type { HostedEvent } from './provider.ts'

test(
  'Claude Stop cancels unread native messages and reports only known input IDs',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-stop-',
    ))
    const native = claudeNative()
    const session = await claudeProvider({ query: native.query }).open({
      cwd: root,
      settings: {},
      env: {},
      signal: new AbortController().signal,
    })
    const input = inbox()
    const events: HostedEvent[] = []

    const messages = async function* () {
      for await (const message of input) {
        yield {
          id: message.id!,
          text: message.text,
          images: [],
        }
      }
    }

    const consume = async () => {
      for await (const event of session.run({
        input: messages(),
        permission: async () => ({
          behavior: 'deny',
          message: 'unused',
        }),
      })) {
        events.push(event)
      }
    }

    const done = consume()
    t.after(async () => {
      input.end()
      session.close()
      await done
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    input.push({
      id: 'opening',
      text: 'Start',
    })
    input.push({
      id: 'queued',
      text: 'Read next',
    })
    await until({
      what: 'native messages',
      check: () => native.incoming.length === 2,
    })
    native.cancelled.push(
      native.incoming[1]!.uuid!,
      'internal-unknown-uuid',
    )
    await session.interrupt()
    await until({
      what: 'cancelled input receipt',
      check: () => events.some(event =>
        typeof event === 'object' && event.type === 'input' && event.receipt.phase === 'refused'),
    })
    assert.deepEqual(
      native.interrupts,
      [{ cancelQueued: true }],
    )
    assert.deepEqual(
      events.flatMap(event => typeof event === 'object' && event.type === 'input'
    && event.receipt.phase === 'refused' ? [event.receipt.inputId] : []),
      ['queued'],
    )
    assert.equal(
      session.snapshot().work.unsettledInputs.includes('queued'),
      false,
    )
    await session.interrupt({ cancelQueued: false })
    assert.deepEqual(
      native.interrupts.at(-1),
      { cancelQueued: false },
    )
  },
)

test(
  'Stop during Claude context preparation cancels that input before the SDK takes it',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-stop-context-',
    ))
    const native = claudeNative()
    let release = () => {}
    const context = new Promise<string>(resolve => {
      release = () => resolve('Synthetic context')
    })
    let preparing = false
    const session = await claudeProvider({ query: native.query }).open({
      cwd: root,
      settings: {},
      env: {},
      signal: new AbortController().signal,
      context: async () => {
        preparing = true

        return context
      },
    })
    const input = inbox()
    const events: HostedEvent[] = []

    const messages = async function* () {
      for await (const message of input) {
        yield {
          id: message.id!,
          text: message.text,
          images: [],
        }
      }
    }

    const read = async () => {
      for await (const event of session.run({
        input: messages(),
        permission: async () => ({
          behavior: 'deny',
          message: 'unused',
        }),
      })) {
        events.push(event)
      }
    }

    const done = read()
    t.after(async () => {
      release(); input.end(); session.close(); await done
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    input.push({
      id: 'waiting',
      text: 'Must not start',
    })
    await until({
      what: 'context render',
      check: () => preparing,
    })
    await session.interrupt()
    release()
    await until({
      what: 'cancelled preparing input',
      check: () => events.some(event =>
        typeof event === 'object' && event.type === 'input' && event.receipt.phase === 'refused'),
    })
    assert.equal(
      native.incoming.length,
      0,
    )
    input.push({
      id: 'next',
      text: 'Owner resumes',
    })
    await until({
      what: 'next owner input',
      check: () => native.incoming.length === 1,
    })
    assert.match(
      String(native.incoming[0]!.message.content),
      /Owner resumes/,
    )
  },
)

test(
  'Codex Send now continues with the latest steered message after interrupting the turn',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-now-',
    ))
    const native = replayCodex({hydra:()=> 'codex-stop'})
    const held = native.plan({
      text: 'Start Codex',
      hold: true,
    })
    const session = await codexProvider({spawnCodex:native.spawnCodex}).open({
      cwd:root,
      settings:{},
      env:{PNYX_HYDRA:'codex-stop'},
      signal:new AbortController().signal,
    })
    const input = inbox()
    const events: HostedEvent[] = []

    const messages = async function* () {
      for await(const message of input) {
        yield {
          id:message.id!,
          text:message.text,
          images:[],
        }
      }
    }

    const consume = async () => {
      for await(const event of session.run({
        input:messages(),
        permission:async()=>({
          behavior:'deny',
          message:'unused',
        }),
      })){
        events.push(event)
      }
    }

    const done=consume()
    t.after(async()=>{
      input.end();session.close();held.release();await done;rmSync(
        root,
        {
          recursive:true,
          force:true,
        },
      )
    })
    input.push({
      id:'open',
      text:'Start Codex',
    })
    await until({
      what:'Codex opening turn',
      check:()=>session.snapshot().work.runningTurns.length===1,
    })
    input.push({
      id:'steer',
      text:'Answer ONLY LATEST_MESSAGE',
    })
    await until({
      what:'steered input',
      check:()=>events.some(event=>typeof event==='object' && event.type==='input' && event.receipt.inputId==='steer' && event.receipt.phase==='confirmed'),
    })
    await session.interrupt({cancelQueued:false})
    await until({
      what:'continuation completes',
      check:()=>events.some(event=>typeof event==='object' && event.type==='turn-ended' && event.outcome.status==='completed'),
    })
    assert.match(
      native.sessions[0]!.received[2]!,
      /Answer ONLY LATEST_MESSAGE/,
    )
    assert.equal(
      events.some(event=>typeof event==='object' && event.type==='turn-ended' && event.outcome.status==='interrupted'),
      true,
    )
  },
)
