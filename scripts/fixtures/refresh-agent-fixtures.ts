// pnpm refresh-agent-fixtures, by hand after upgrading the Agent SDK or Codex (never in verify): records one real
// turn of each into src/test-harness/recordings/ with your logins, in a temporary folder and PNYX_HOME so no hook reaches your Pnyx.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const OUT = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'test-harness',
  'recordings',
)
const PROMPT = 'Reply with exactly this sentence and nothing else: Recorded reply.'
const TIMEOUT_MS = 120_000
const work = realpathSync(mkdtempSync(join(
  tmpdir(),
  'pnyx-refresh-',
)))
const env = {
  ...process.env,
  PNYX_HOME: join(
    work,
    'pnyx',
  ),
}

// Paths on this machine never land in the fixtures.
function scrub({ value }: { value: unknown }): unknown {
  return JSON.parse(JSON.stringify(value)
    .replaceAll(
      work,
      '/work',
    )
    .replaceAll(
      homedir(),
      '/home/owner',
    ))
}

function write({
  name,
  value,
}: {
  name: string
  value: unknown
}) {
  writeFileSync(
    join(
      OUT,
      name,
    ),
    `${JSON.stringify(
      scrub({ value }),
      null,
      2,
    )}\n`,
  )
  console.log(`wrote src/test-harness/recordings/${name}`)
}

// System messages that list the local commands, plugins and servers are left out; init keeps only what a session needs.
const SYSTEM = [
  'init',
  'status',
  'session_state_changed',
]
// The Codex notifications a turn of Pnyx's reads; the rest (MCP servers, hooks, warnings) describe this machine.
const NOTIFICATIONS = [
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'turn/completed',
]

function keep({ message }: { message: SDKMessage }): SDKMessage[] {
  if (message.type === 'system' && !SYSTEM.includes(message.subtype)) {
    return []
  }

  return [
    message.type === 'system' && message.subtype === 'init'
      ? {
        type: message.type,
        subtype: message.subtype,
        session_id: message.session_id,
        uuid: message.uuid,
        model: message.model,
        cwd: message.cwd,
        permissionMode: message.permissionMode,
        claude_code_version: message.claude_code_version,
      } as SDKMessage
      : message,
  ]
}

async function recordClaude() {
  let done = () => {}
  const finished = new Promise<void>(resolve => {
    done = resolve
  })

  const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: PROMPT,
      },
      parent_tool_use_id: null,
    }
    await finished
  }

  const abortController = new AbortController()
  const timer = setTimeout(
    () => abortController.abort(),
    TIMEOUT_MS,
  )
  const session = query({
    prompt: prompt(),
    options: {
      cwd: work,
      env,
      model: 'haiku',
      includePartialMessages: true,
      persistSession: false,
      pathToClaudeCodeExecutable: 'claude',
      settingSources: [],
      tools: [],
      abortController,
    },
  })
  const models = await session.supportedModels()
  const turn: SDKMessage[] = []

  for await (const message of session) {
    turn.push(...keep({ message }))

    if (message.type === 'result') {
      done()
    }
  }

  clearTimeout(timer)

  const { version } = JSON.parse(readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ),
    'utf8',
  )) as { version: string }

  write({
    name: 'claude.json',
    value: {
      sdk: version,
      claude: execFileSync(
        'claude',
        ['--version'],
        { encoding: 'utf8' },
      ).trim(),
      models,
      turn,
    },
  })
}

type Message = Record<string, unknown>

// The method names of one generated protocol union.
function methods({
  folder,
  name,
}: {
  folder: string
  name: string
}): string[] {
  const schema = JSON.parse(readFileSync(
    join(
      folder,
      `${name}.json`,
    ),
    'utf8',
  )) as { oneOf?: { properties?: { method?: { enum?: string[] } } }[] }

  return (schema.oneOf ?? []).flatMap(o => o.properties?.method?.enum ?? []).sort()
}

async function recordCodex() {
  const schemas = join(
    work,
    'schema',
  )
  execFileSync(
    'codex',
    [
      'app-server',
      'generate-json-schema',
      '--out',
      schemas,
    ],
  )
  // Only the login is copied, so your config, MCP servers and hooks stay out of the recording.
  const home = join(
    work,
    'codex-home',
  )
  mkdirSync(home)
  copyFileSync(
    join(
      process.env.CODEX_HOME ?? join(
        homedir(),
        '.codex',
      ),
      'auth.json',
    ),
    join(
      home,
      'auth.json',
    ),
  )
  const child = spawn(
    'codex',
    [
      'app-server',
      '--listen',
      'stdio://',
    ],
    {
      cwd: work,
      env: {
        ...env,
        CODEX_HOME: home,
      },
      stdio: 'pipe',
    },
  )
  // Settles every wait below when Codex exits or the timeout kills it.
  const exited = new Promise<never>((
    _,
    reject,
  ) => child.once(
    'exit',
    code => reject(new Error(`codex app-server exited (${code})`)),
  ))
  exited.catch(() => {})
  const lines = createInterface({ input: child.stdout })
  const waiting = new Map<number, ({ message }: { message: Message }) => void>()
  const session: Message[] = []
  let completed = () => {}
  const turnDone = new Promise<void>(resolve => {
    completed = resolve
  })

  lines.on(
    'line',
    line => {
      const message = JSON.parse(line) as Message

      // A request Codex makes of the client is never recorded; this turn asks for nothing.
      if (typeof message.method === 'string' && message.id === undefined) {
        if (NOTIFICATIONS.includes(message.method)) {
          session.push({ notification: message })
        }

        if (message.method === 'turn/completed') {
          completed()
        }
      }

      if (message.method === undefined) {
        waiting.get(message.id as number)?.({ message })
      }
    },
  )

  let next = 0

  const request = async ({
    method,
    params,
    record = ({ result }: { result: Message }) => result,
  }: {
    method: string
    params: Message
    record?: ({ result }: { result: Message }) => Message
  }) => {
    const id = next++
    const reply = new Promise<Message>(resolve => waiting.set(
      id,
      ({ message }) => resolve(message),
    ))
    child.stdin.write(`${JSON.stringify({
      id,
      method,
      params,
    })}\n`)
    const message = await Promise.race([
      reply,
      exited,
    ])

    if (message.error) {
      throw new Error(`${method}: ${JSON.stringify(message.error)}`)
    }

    session.push({
      method,
      result: record({ result: message.result as Message }),
    })

    return message.result as Message
  }

  const timer = setTimeout(
    () => child.kill(),
    TIMEOUT_MS,
  )

  try {
    await request({
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'pnyx',
          version: '0',
        },
      },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    await request({
      method: 'model/list',
      params: {},
    })
    // Only the settings Pnyx reads; the rest of a config can hold secrets.
    await request({
      method: 'config/read',
      params: { cwd: work },
      record: ({ result: { config } }) => {
        const {
          approval_policy,
          sandbox_mode,
          model_reasoning_effort,
        } = config as Message

        return {
          config: {
            approval_policy,
            sandbox_mode,
            model_reasoning_effort,
          },
        }
      },
    })
    const started = await request({
      method: 'thread/start',
      params: {
        cwd: work,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      },
    })
    const threadId = (started.thread as Message).id
    await request({
      method: 'turn/start',
      params: {
        threadId,
        input: [
          {
            type: 'text',
            text: PROMPT,
          },
        ],
      },
    })
    await Promise.race([
      turnDone,
      exited,
    ])
  } finally {
    clearTimeout(timer)
    child.kill()
  }

  write({
    name: 'codex.json',
    value: {
      codex: execFileSync(
        'codex',
        ['--version'],
        { encoding: 'utf8' },
      ).trim(),
      protocol: {
        clientRequests: methods({
          folder: schemas,
          name: 'ClientRequest',
        }),
        serverRequests: methods({
          folder: schemas,
          name: 'ServerRequest',
        }),
        serverNotifications: methods({
          folder: schemas,
          name: 'ServerNotification',
        }),
      },
      session,
    },
  })
}

try {
  await recordClaude()
  await recordCodex()
} finally {
  rmSync(
    work,
    {
      recursive: true,
      force: true,
    },
  )
}
