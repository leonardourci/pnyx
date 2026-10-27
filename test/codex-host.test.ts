import { steeringNotice } from '../src/task-inbox/notice.ts'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { fakeDispatch } from '../src/test-harness/dispatch-fixture.ts'
import { harvestTranscripts } from '../src/integrations/hooks/harvest.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import type { RunningServer } from '../src/server/server.ts'
import { hostObserver } from '../src/test-harness/host-observer.ts'
import { once } from 'node:events'
import { askHost } from '../src/server/state.ts'
import { loadHydra, readEvents, spoolWrite, withWriter } from '../src/store/hydra-store.ts'
import { fakeCodex } from '../src/test-harness/codex-fixture.ts'
import { stopProcess } from '../src/test-harness/processes.ts'
import { hydraSdk } from '../src/test-harness/hydra-host-fixture.ts'
import { MAX_IMAGE_BYTES } from '../src/attachments/images.ts'
import { codexProvider } from '../src/server/codex.ts'
import type { HostedEvent } from '../src/server/provider.ts'

const meta = {
  at: '2026-10-15T00:00:00Z',
  actor: 'test',
  id: 'start-1',
}
let server: RunningServer | undefined

afterEach(async () => {
  await server?.close(); server = undefined
})

const {
  startServer,
  until,
} = hostObserver({ describe: () => loadHydra({ hydraId: 'lab' }).state })

async function lab({ refuse }: { refuse?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-codex-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  fakeDispatch({ root })
  process.env.CODEX_HOME = join(
    root,
    'codex',
  )
  await commands.hydra([
    'create',
    'lab',
    '--hydra',
    'lab',
  ])
  await commands.task([
    'create',
    '--title',
    'Ship it',
    '--key',
    'ship',
    '--folder',
    root,
    '--hydra',
    'lab',
  ])
  await commands.task([
    'brief',
    'ship',
    '--brief',
    'Release the canary.',
    '--hydra',
    'lab',
  ])
  await dispatchCommands.rule([
    'set',
    'default',
    '--harness',
    'codex',
    '--model',
    'gpt-6.1-sol',
    '--effort',
    'high',
    '--mode',
    'on-request',
    '--hydra',
    'lab',
  ])
  const fixture = fakeCodex({
    root,
    refuse,
    models: [
      'gpt-6.1-sol',
      'gpt-6-luna',
      'gpt-6-astra',
    ],
  })
  server = await startServer({
    hydraId: 'lab',
    spawnCodex: fixture.spawnCodex,
    query: hydraSdk().query,
  })

  // A start checks the model against the catalog, read once per server; the thread processes come after it.
  if (refuse !== 'initialize') {
    await askHost({
      hydraId: 'lab',
      body: {
        action: 'models',
        harness: 'codex',
      },
    })
    fixture.children.splice(0)
    fixture.environments.splice(0)
  }

  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = () => state().cards[state().keys.ship!]!
  const send = ({ text }: { text: string }) => sendReply({
    hydraId: 'lab',
    request: {
      card: 'ship',
      text,
      homes: [],
      actor: 'test',
    },
  })
  // The picker's own route; the agent CLI adds a fixed read-back wait on top of it.
  const set = ({
    setting,
    value,
  }: {
    setting: string
    value: string
  }) => askHost({
    hydraId: 'lab',
    body: {
      action: 'set',
      card: 'ship',
      setting,
      value,
    },
  })
  const turns = () => fixture.messages().filter(m => m.method === 'turn/start')
  const approvals = () => fixture.messages().filter(m => m.id === 'approval')
  const answer = ({
    id,
    args,
  }: {
    id: string
    args: string[]
  }) => commands.task([
    'permission',
    'ship',
    id,
    ...args,
    '--hydra',
    'lab',
  ])

  return {
    root,
    fixture,
    task,
    send,
    set,
    turns,
    approvals,
    answer,
  }
}

test(
  'Codex starts through app-server by default and records its native thread, history and settings',
  async () => {
    const {
      root,
      fixture,
      task,
      send,
      set,
      turns,
    } = await lab()
    const result = await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    assert.deepEqual(
      result.agent,
      {
        harness: 'codex',
        session: '0199f00d-1111-7000-8000-000000000001',
        folder: root,
        host: 'pnyx',
      },
    )
    await until({ check: () => task().sessionActivity === 'finished' })
    const {
      provider,
      loginFolder,
      transcriptPath,
    } = task().agent!
    assert.deepEqual(
      {
        provider,
        loginFolder,
        transcriptPath,
        codexHome: fixture.environments[0]?.CODEX_HOME,
      },
      {
        provider: 'codex',
        loginFolder: join(
          root,
          'codex',
        ),
        transcriptPath: fixture.transcript,
        codexHome: join(
          root,
          'codex',
        ),
      },
    )
    assert.match(
      task().launch?.dispatch ?? '',
      /on codex:test/,
    )
    assert.deepEqual(
      task().settings,
      {
        model: 'gpt-6.1-sol',
        effort: 'high',
        mode: 'on-request',
      },
    )
    assert.deepEqual(
      fixture.messages().find(m => m.method === 'thread/start')!.params,
      {
        cwd: root,
        config: {
          'shell_environment_policy.set.PNYX_ACTOR': `worker:${task().id}`,
          'shell_environment_policy.set.PNYX_HOME': process.env.PNYX_HOME,
          'shell_environment_policy.set.PNYX_HYDRA': 'lab',
          'shell_environment_policy.set.PNYX_STEERING_WORKER': fixture.environments[0]!.PNYX_STEERING_WORKER,
          'features.default_mode_request_user_input': true,
        },
        model: 'gpt-6.1-sol',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    )
    const first = turns()[0]!.params!
    assert.match(
      String((first.input as { text: string }[])[0]!.text),
      /^<pnyx-worker [^>]*>[\s\S]*<\/pnyx-worker>\n\nRelease the canary\.\n\nYou are the Pnyx worker/,
    )
    assert.deepEqual(
      [
        first.effort,
        first.approvalPolicy,
        first.sandboxPolicy,
      ],
      [
        'high',
        'on-request',
        {
          type: 'workspaceWrite',
          writableRoots: [process.env.PNYX_HOME],
          networkAccess: true,
        },
      ],
    )

    // Picker changes reach the next turn of the same process; a Claude bypass becomes never with full access.
    await set({
      setting: 'model',
      value: 'gpt-6-luna',
    })
    await set({
      setting: 'effort',
      value: 'low',
    })
    await set({
      setting: 'mode',
      value: 'bypassPermissions',
    })
    assert.equal(
      (await send({ text: 'Next turn' })).state,
      'delivered',
    )
    await until({ check: () => turns().length === 2 && task().sessionActivity === 'finished' })
    const {
      model,
      effort,
      approvalPolicy,
      sandboxPolicy,
    } = turns()[1]!.params!
    assert.deepEqual(
      {
        model,
        effort,
        approvalPolicy,
        sandboxPolicy,
      },
      {
        model: 'gpt-6-luna',
        effort: 'low',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    )
    assert.equal(
      fixture.children.length,
      1,
    )
  },
)

test(
  'an image added in the web is stored, served with the token and reaches Codex as a local image',
  async () => {
    const {
      task,
      send,
      turns,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    const token = readFileSync(
      join(
        process.env.PNYX_HOME!,
        'token',
      ),
      'utf8',
    ).trim()
    const png = new Uint8Array(Buffer.from(
      '89504e470d0a1a0a',
      'hex',
    ))
    const upload = ({
      type,
      auth = token,
      body = png,
    }: {
      type: string
      auth?: string
      body?: Uint8Array<ArrayBuffer>
    }) => fetch(
      new URL(
        'attachments',
        server!.url,
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth}`,
          'content-type': type,
        },
        body,
      },
    )
    assert.equal(
      (await upload({
        type: 'image/png',
        auth: 'wrong',
      })).status,
      401,
    )
    assert.equal(
      (await upload({
        type: 'image/png',
        body: new Uint8Array(MAX_IMAGE_BYTES + 1),
      })).status,
      413,
    )
    assert.equal(
      (await upload({ type: 'text/html' })).status,
      415,
    )
    const {
      path,
      line,
    } = await (await upload({ type: 'image/png' })).json() as {
      path: string
      line: string
    }
    assert.equal(
      line,
      `[image: ${path}]`,
    )
    assert.ok(path.startsWith(join(
      process.env.PNYX_HOME!,
      'hydras',
      'lab',
      'attachments',
    )))
    const served = new URL(
      `attachments/${path.split('/').at(-1)}`,
      server!.url,
    )
    assert.equal(
      (await fetch(served)).status,
      401,
    )
    served.searchParams.set(
      'token',
      token,
    )
    const image = await fetch(served)
    assert.equal(
      image.headers.get('content-type'),
      'image/png',
    )
    assert.deepEqual(
      new Uint8Array(await image.arrayBuffer()),
      png,
    )

    assert.equal(
      (await send({ text: `What broke?\n\n${line}\n\n[image: /etc/passwd]` })).state,
      'delivered',
    )
    await until({ check: () => turns().length === 2 })
    assert.deepEqual(
      (turns()[1]!.params!.input as unknown[]).slice(1),
      [
        {
          type: 'localImage',
          path,
        },
      ],
    )
  },
)

test(
  'a failed Codex start leaves the task free, and a crashed or failed turn is interrupted',
  async () => {
    const refused = await lab({ refuse: 'thread/start' })
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task: 'ship',
        meta,
      }),
      /fixture refused thread/,
    )
    assert.equal(
      refused.task().agent,
      undefined,
    )
    await server!.close()
    server = undefined
    const {
      fixture,
      task,
      send,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'CRASH' })
    await until({ check: () => task().activity === 'interrupted' })
    assert.match(
      task().attention[0]!.text!,
      /Codex/,
    )
    await send({ text: 'FAIL' })
    await until({ check: () => fixture.children.length === 2 && task().activity === 'interrupted' })
    assert.match(
      task().attention[0]!.text!,
      /fixture failure/,
    )
  },
)

test(
  'an idle Codex process that exits is resumed before accepting the next message',
  async () => {
    const {
      fixture,
      task,
      send,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    const closed = once(
      fixture.children[0]!,
      'close',
      { signal: AbortSignal.timeout(30_000) },
    )
    fixture.children[0]!.kill()
    await closed
    assert.equal(
      (await send({ text: 'Resume after idle exit' })).state,
      'delivered',
    )
    await until({ check: () => fixture.children.length === 2 && task().sessionActivity === 'finished' })
    assert.ok(fixture.messages().some(m => m.method === 'thread/resume'))
  },
)

test(
  'a concurrent start is refused and shutdown closes a Codex process still initializing',
  async () => {
    const {
      fixture,
      task,
    } = await lab({ refuse: 'initialize' })
    // A candidate without a model needs no catalog, which this Codex could not give.
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      '',
      '--hydra',
      'lab',
    ])
    const starting = startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    void starting.catch(() => {})
    await Promise.race([
      fixture.initializing,
      starting,
    ])
    assert.ok(fixture.messages().some(m => m.method === 'initialize'))
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task: 'ship',
        meta: {
          ...meta,
          id: 'start-2',
        },
      }),
      /already starting/,
    )
    await server!.close()
    server = undefined
    await assert.rejects(
      starting,
      /closed|fetch failed/,
    )
    const child = fixture.children[0]!
    await until({ check: () => child.exitCode !== null || child.signalCode !== null })
    assert.equal(
      task().agent,
      undefined,
    )
  },
)

test(
  'an owner harness choice takes that harness\'s candidate, and its override reaches the first Codex turn',
  async () => {
    const {
      fixture,
      task,
      turns,
    } = await lab()
    await dispatchCommands.rule([
      'set',
      'default',
      '--candidates',
      JSON.stringify([
        {
          harness: 'claude',
          model: 'opus',
          effort: 'max',
        },
        {
          harness: 'codex',
          model: 'gpt-6-luna',
          effort: 'low',
        },
      ]),
      '--hydra',
      'lab',
    ])
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      harness: 'codex',
      override: {
        effort: 'xhigh',
        mode: 'never',
        fast: true,
      },
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.equal(
      task().agent?.provider,
      'codex',
    )
    const thread = fixture.messages().find(m => m.method === 'thread/start')!.params!
    assert.deepEqual(
      [
        thread.model,
        thread.serviceTier,
      ],
      [
        'gpt-6-luna',
        'fast',
      ],
    )
    const {
      model,
      effort,
      approvalPolicy,
      serviceTier,
    } = turns()[0]!.params!
    assert.deepEqual(
      {
        model,
        effort,
        approvalPolicy,
        serviceTier,
      },
      {
        model: 'gpt-6-luna',
        effort: 'xhigh',
        approvalPolicy: 'never',
        serviceTier: 'fast',
      },
    )
    assert.deepEqual(
      task().settings,
      {
        model: 'gpt-6-luna',
        effort: 'xhigh',
        mode: 'never',
        fast: 'true',
      },
    )
    assert.match(
      task().launch?.dispatch ?? '',
      /owner override/,
    )
  },
)

test(
  'native hook and transcript settings preserve hosted picker changes across restart',
  async () => {
    const {
      root,
      fixture,
      task,
      send,
      set,
      turns,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'HOLD' })
    await until({
      check: () => turns().length === 2
        && task().steering?.every(message => message.ack !== undefined) === true,
    })
    const id = task().agent!.sessionId
    await set({
      setting: 'model',
      value: 'gpt-6-luna',
    })
    await set({
      setting: 'effort',
      value: 'low',
    })
    await set({
      setting: 'mode',
      value: 'never',
    })
    const desired = {
      model: 'gpt-6-luna',
      effort: 'low',
      mode: 'never',
    }
    spoolWrite({
      hydraId: 'lab',
      entry: {
        v: 1,
        id: 'native-settings',
        at: new Date().toISOString(),
        harness: 'codex',
        event: 'PreToolUse',
        payload: {
          session_id: id,
          cwd: root,
          model: 'gpt-6.1-sol',
          effort: 'high',
          permission_mode: 'on-request',
          tool_name: 'shell',
          tool_input: { command: 'true' },
        },
      },
    })
    ingestSpool({ hydraId: 'lab' })
    assert.deepEqual(
      task().settings,
      desired,
    )
    appendFileSync(
      fixture.transcript,
      `${JSON.stringify({
        type: 'turn_context',
        timestamp: new Date().toISOString(),
        payload: {
          model: 'gpt-6.1-sol',
          effort: 'high',
          approval_policy: 'on-request',
        },
      })}\n`,
    )
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => harvestTranscripts({
        writer,
        cardIds: [task().id],
        at: new Date().toISOString(),
      }),
    })
    const harvested = task().settings!
    assert.deepEqual(
      {
        model: harvested.model,
        effort: harvested.effort,
        mode: harvested.mode,
      },
      desired,
    )

    // The server closes the held turn; the restart continues it once in the same thread.
    await server!.close()
    server = await startServer({
      hydraId: 'lab',
      spawnCodex: fixture.spawnCodex,
    })
    await until({ check: () => fixture.children.length === 2 && task().sessionActivity === 'finished' })
    assert.equal(
      fixture.messages().find(m => m.method === 'thread/resume')?.params?.threadId,
      id,
    )
    assert.equal(
      task().attention.some(a => a.key === 'pnyx:interrupted'),
      false,
    )
    const {
      model,
      effort,
      approvalPolicy,
    } = turns().at(-1)!.params!
    assert.deepEqual(
      {
        model,
        effort,
        mode: approvalPolicy,
      },
      desired,
    )
  },
)

test(
  'Codex steers a reply into its running turn, and its command and file approvals wait for the answer and apply only to that call',
  async () => {
    const {
      fixture,
      task,
      send,
      turns,
      approvals,
      answer,
    } = await lab()
    const steers = () => fixture.messages().filter(m => m.method === 'turn/steer')
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'HOLD' })
    await until({ check: () => turns().length === 2 && task().sessionActivity === 'working' })
    await send({ text: 'Also check the docs' })
    await until({ check: () => steers().length === 1 })
    assert.deepEqual(
      [
        steers()[0]?.params?.expectedTurnId,
        (steers()[0]?.params?.input as { text: string }[])[0]?.text,
        turns().length,
        task().sessionActivity,
      ],
      [
        'turn-2',
        steeringNotice({
          task: task().id,
          hydraId: 'lab',
          ids: [task().steering!.at(-1)!.id],
        }),
        2,
        'working',
      ],
    )
    fixture.children[0]!.kill('SIGUSR1')
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'DENY' })
    await until({ check: () => task().permissions?.[0]?.status === 'pending' })
    assert.equal(
      approvals().length,
      0,
    )
    await answer({
      id: task().permissions![0]!.id,
      args: ['deny'],
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.equal(
      approvals()[0]?.result?.decision,
      'decline',
    )

    await send({ text: 'ALLOW' })
    await until({ check: () => task().permissions?.length === 2 })
    const command = task().permissions![1]!
    assert.deepEqual(
      [
        command.tool,
        command.input.command,
      ],
      [
        'Command',
        'touch allowed.txt',
      ],
    )
    await answer({
      id: command.id,
      args: [
        'allow',
        '--actor',
        'hydra',
        '--reason',
        'Scoped to the task folder',
      ],
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.equal(
      task().permissions![1]!.status,
      'allow',
    )
    await assert.rejects(
      async () => answer({
        id: command.id,
        args: ['deny'],
      }),
      /already allow/,
    )

    await send({ text: 'FILE' })
    await until({ check: () => task().permissions?.length === 3 })
    const file = task().permissions![2]!
    assert.equal(
      file.tool,
      'File change',
    )
    assert.deepEqual(
      file.input.changes,
      [
        {
          path: 'allowed.txt',
          diff: '+approved',
          kind: { type: 'add' },
        },
      ],
    )
    const second = await answer({
      id: file.id,
      args: [
        'allow',
        '--actor',
        'hydra',
        '--reason',
        'Same file',
      ],
    }) as { posted?: string }
    assert.equal(
      second.posted,
      undefined,
    )
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.hydraMessages?.filter(m => m.text.startsWith('Allowed ')).length ?? 0,
      0,
    )
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.deepEqual(
      approvals().map(m => m.result?.decision),
      [
        'decline',
        'accept',
        'accept',
      ],
    )
    assert.equal(
      task().column,
      loadHydra({ hydraId: 'lab' }).state.config?.columns.find(c => c.role === 'in_progress')?.id,
    )
  },
)

test(
  'a request Codex resolves itself expires rather than leave answer controls',
  async () => {
    const {
      fixture,
      task,
      send,
      approvals,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'CANCEL' })
    await until({ check: () => task().permissions?.length === 1 })
    fixture.children[0]!.kill('SIGUSR2')
    await until({ check: () => task().permissions?.[0]?.status === 'expired' && task().sessionActivity === 'finished' })
    assert.equal(
      approvals().length,
      0,
    )
    assert.equal(
      task().attention.some(a => a.key.startsWith('pnyx:permission:')),
      false,
    )
  },
)

test(
  'Codex permission profiles grant only the requested turn scope and denial grants nothing',
  async () => {
    const {
      task,
      send,
      approvals,
      answer,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })

    for (const [
      index,
      choice,
    ] of ([
        'allow',
        'deny',
      ] as const).entries()) {
      await send({ text: `PERMISSIONS_${choice.toUpperCase()}` })
      await until({ check: () => task().permissions?.length === index + 1 })
      const request = task().permissions![index]!
      assert.deepEqual(
        [
          request.tool,
          request.input.scope,
        ],
        [
          'Turn permissions',
          'turn',
        ],
      )
      await answer({
        id: request.id,
        args: [choice],
      })
      await until({ check: () => task().sessionActivity === 'finished' })
      assert.deepEqual(
        approvals()[index]!.result,
        {
          permissions: choice === 'allow' ? { network: { enabled: true } } : {},
          scope: 'turn',
        },
      )
    }
  },
)

test(
  'Codex questions and MCP forms wait on the task and get the owner’s answer',
  async () => {
    const {
      task,
      send,
      approvals,
      answer,
    } = await lab()
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta,
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    await send({ text: 'QUESTION' })
    await until({ check: () => task().permissions?.length === 1 })
    const question = task().permissions![0]!
    assert.equal(
      question.tool,
      'Question',
    )
    assert.deepEqual(
      question.questions?.map(q => [
        q.question,
        q.options.map(o => o.label),
      ]),
      [
        [
          'Cover http links?',
          [
            'Yes',
            'No',
          ],
        ],
        [
          'What should the test be called?',
          [],
        ],
      ],
    )
    assert.equal(
      question.input.threadId,
      undefined,
    )
    await assert.rejects(
      async () => answer({
        id: question.id,
        args: [
          'allow',
          '--answer',
          '{"answers":[{"pick":[3]},{"text":"x"}]}',
        ],
      }),
      /option numbers from 1 to 2/,
    )
    await answer({
      id: question.id,
      args: [
        'allow',
        '--answer',
        '{"answers":[{"pick":[1]},{"text":"covers http"}]}',
      ],
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.deepEqual(
      approvals()[0]?.result,
      {
        answers: {
          scheme: { answers: ['Yes'] },
          name: { answers: ['covers http'] },
        },
      },
    )
    // Free text reaches Codex but is never written to the log.
    assert.deepEqual(
      task().permissions![0]!.answers,
      [
        ['Yes'],
        ['(hidden)'],
      ],
    )
    assert.equal(
      JSON.stringify(readEvents({ hydraId: 'lab' })).includes('covers http'),
      false,
    )

    await send({ text: 'QUESTION' })
    await until({ check: () => task().permissions?.length === 2 })
    await answer({
      id: task().permissions![1]!.id,
      args: ['deny'],
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.deepEqual(
      approvals()[1]?.result,
      { answers: {} },
    )

    await send({ text: 'ELICIT' })
    await until({ check: () => task().permissions?.length === 3 })
    const elicitation = task().permissions![2]!
    assert.deepEqual(
      elicitation.form,
      [
        {
          name: 'priority',
          type: 'string',
          options: [
            'low',
            'high',
          ],
          required: true,
        },
      ],
    )
    await answer({
      id: elicitation.id,
      args: [
        'allow',
        '--answer',
        '{"values":{"priority":"high"}}',
      ],
    })
    await until({ check: () => task().sessionActivity === 'finished' })
    assert.deepEqual(
      approvals()[2]?.result,
      {
        action: 'accept',
        content: { priority: 'high' },
      },
    )

    await send({ text: 'ALLOW' })
    await until({ check: () => task().permissions?.length === 4 })
    await assert.rejects(
      async () => answer({
        id: task().permissions![3]!.id,
        args: [
          'allow',
          '--answer',
          '{"answers":[]}',
        ],
      }),
      /takes allow or deny without an answer/,
    )
  },
)

test(
  'a missing Codex request times out with recent messages even while setTimeout is mocked',
  { timeout: 1000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-request-wait-',
    )))
    const codex = fakeCodex({ root })
    mock.timers.enable({ apis: ['setTimeout'] })

    try {
      await assert.rejects(
        codex.waitForRequest({
          method: 'thread/start',
          timeoutMs: 10,
        }),
        error => {
          assert.ok(error instanceof Error)
          assert.match(
            error.message,
            /timed out waiting for Codex thread\/start after 10ms/,
          )
          assert.ok(error.message.includes('"recent":[]'))
          assert.ok(error.message.includes('"children":[]'))

          return true
        },
      )
      const failure = new Error('initialization refused')
      await assert.rejects(
        codex.waitForRequest({
          method: 'thread/start',
          failure: () => failure,
        }),
        failure,
      )
    } finally {
      mock.timers.reset()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a Codex thread that takes longer than a request\'s 30 seconds to open still opens',
  async () => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-slow-',
    )))
    const codex = fakeCodex({
      root,
      holdOpen: true,
    })
    // Only setTimeout is faked, so the fixture's pipes and setImmediate run for real.
    mock.timers.enable({ apis: ['setTimeout'] })

    try {
      const opening = codexProvider({ spawnCodex: codex.spawnCodex }).open({
        cwd: root,
        settings: {},
        env: {
          ...process.env,
          CODEX_HOME: root,
        },
        signal: new AbortController().signal,
      })
      let failure: Error | undefined
      void opening.catch((error: Error) => {
        failure = error
      })

      await codex.waitForRequest({
        method: 'thread/start',
        failure: () => failure,
      })

      mock.timers.tick(60_000)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(
        failure,
        undefined,
      )
      codex.children[0]!.kill('SIGHUP')
      const session = await opening
      assert.equal(
        session.id,
        '0199f00d-1111-7000-8000-000000000001',
      )
      session.close()
    } finally {
      mock.timers.reset()
      await Promise.all(codex.children.map(child => child.pid && child.exitCode === null
        ? stopProcess({ pid: child.pid }) : Promise.resolve()))
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a Codex command item reports its tool call running, then done, inside the turn',
  async () => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-tool-',
    )))
    const codex = fakeCodex({ root })
    const session = await codexProvider({ spawnCodex: codex.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: {
        ...process.env,
        CODEX_HOME: root,
      },
      signal: new AbortController().signal,
    })

    const input = async function* () {
      yield 'COMMAND'
    }

    const events: HostedEvent[] = []

    for await (const event of session.run({
      input: input(),
      permission: async () => ({
        behavior: 'deny',
        message: 'no',
      }),
    })) {
      events.push(event)
    }

    session.close()
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
    assert.deepEqual(
      events.filter(event => typeof event !== 'string' && event.type === 'tool'),
      [
        {
          type: 'tool',
          id: 'command-run',
          running: true,
        },
        {
          type: 'tool',
          id: 'command-run',
          running: false,
        },
      ],
    )
  },
)

test(
  'Codex reasoning emits boundaries without streaming its text',
  async () => {
    const root = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-codex-tool-',
    )))
    const codex = fakeCodex({ root })
    const session = await codexProvider({ spawnCodex: codex.spawnCodex }).open({
      cwd: root,
      settings: {},
      env: {
        ...process.env,
        CODEX_HOME: root,
      },
      signal: new AbortController().signal,
    })

    const input = async function* () {
      yield 'THINKING'
    }

    const events: HostedEvent[] = []

    for await (const event of session.run({
      input: input(),
      permission: async () => ({
        behavior: 'deny',
        message: 'no',
      }),
    })) {
      events.push(event)
    }

    assert.equal(
      JSON.stringify(events).includes('private reasoning'),
      false,
    )
    session.close()
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
    assert.deepEqual(
      events.filter(event => typeof event !== 'string' && event.type === 'thinking'),
      [
        {
          type: 'thinking',
          id: 'reason-1',
          running: true,
        },
        {
          type: 'thinking',
          id: 'reason-1',
          running: false,
        },
      ],
    )
  },
)
