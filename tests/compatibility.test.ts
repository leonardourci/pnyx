import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, test, vi } from 'vitest'
import { agentActor, reportActor } from '#app/actors.ts'
import { visibleText, wakeInput } from '#oracle/text.ts'
import { mentionId, reference, taskMentions } from '#titan/mentions.ts'
import { CLI } from './setup/othrys.ts'
import { compatibleEnvironment } from '#store/legacy-env.ts'
import { readAttempt, saveAttempt } from '#web-titan/outbox.ts'
import { ownerInputUuid } from '#workers/input.ts'
import { withoutInterrupted } from '#workers/session-attachments.ts'
import { permissionAttention } from '#workers/permission-rules.ts'
import { injectedDigest, transcriptText } from '#workers/transcript-content.ts'
import { taskContext } from '#workers/transcript-usage.ts'
import type { Card } from '#tasks/model.ts'
import { setupHooks } from '#setup/hooks.ts'
import { serviceFile, setupService } from '#setup/service.ts'
import { setupSkills } from '#setup/skills.ts'

const root = mkdtempSync(join(
  process.env.HOME!,
  'rebrand-',
))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it(
  'keeps saved native input IDs and server actors stable',
  () => {
    expect(ownerInputUuid({ id: 'saved-owner-message' })).toBe('29809c84-1422-868e-8262-373870bf7c52')
    expect(agentActor({ actor: 'pnyx' })).toBe(true)
    expect(reportActor({ actor: 'pnyx' })).toBe(false)
  },
)

it(
  'clears permission and interruption attention saved under the legacy keys',
  () => {
    const card = {
      attention: [
        {
          kind: 'permission',
          key: 'pnyx:permission:saved',
          blocking: true,
        },
        {
          kind: 'question',
          key: 'pnyx:interrupted',
          blocking: true,
        },
      ],
      permissions: [],
    } as unknown as Card
    permissionAttention({ card })
    card.attention = withoutInterrupted({ attention: card.attention })
    expect(card.attention).toEqual([])
  },
)

it.each([
  { brand: 'pnyx' },
  { brand: 'othrys' },
])(
  'reads historical $brand references without rewriting user text',
  ({ brand }) => {
    const original = `[@Saved task](${brand}-task:task-saved)`
    expect(taskMentions({ text: original })).toEqual([
      {
        id: 'task-saved',
        title: 'Saved task',
      },
    ])
    expect(mentionId({ href: `${brand}-task:task-saved` })).toBe('task-saved')
  },
)

it(
  'writes new task references with the Othrys scheme',
  () => {
    expect(reference({
      kind: 'task',
      value: 'task-new',
      label: 'New',
    })).toBe('[@New](othrys-task:task-new)')
  },
)

it.each([
  { brand: 'pnyx' },
  { brand: 'othrys' },
])(
  'reads internal $brand transcript context and keeps it out of user chat',
  ({ brand }) => {
    const wake = `<${brand}-wake>internal</${brand}-wake>`
    expect(wakeInput({ text: wake })).toBe(true)
    expect(visibleText({ text: wake })).toBe('')
    const digest = `<${brand}-digest>saved context</${brand}-digest>`
    expect(injectedDigest({ text: digest })).toBe(digest)
    expect(taskContext({ text: `<${brand}-report task="task-saved">saved</${brand}-report>` })).toEqual(['task-saved'])
    const worker = `<${brand}-worker>instructions</${brand}-worker>\nOwner message`
    expect(transcriptText({ texts: [{ text: worker }] })).toMatchObject([
      {
        text: 'Owner message',
        othrys: true,
      },
    ])
  },
)

it(
  'updates legacy hooks in place without duplicate reporting and removes both names',
  () => {
    const config = join(
      root,
      'claude-hooks',
    )
    mkdirSync(config)
    const settings = join(
      config,
      'settings.json',
    )
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: "'/old/pnyx-hook.sh' claude Stop",
                },
                {
                  type: 'command',
                  command: 'echo unrelated',
                },
              ],
            },
          ],
        },
      }),
    )
    vi.stubEnv(
      'CLAUDE_CONFIG_DIR',
      config,
    )
    setupHooks({
      harness: 'claude',
      opts: {
        remove: false,
        preview: false,
      },
    })
    const installed = readFileSync(
      settings,
      'utf8',
    )
    expect(installed).not.toContain('/pnyx-hook.sh')
    expect(installed.match(/othrys-hook.sh' claude Stop"/g)).toHaveLength(1)
    expect(installed).toContain('echo unrelated')
    setupHooks({
      harness: 'claude',
      opts: {
        remove: true,
        preview: false,
      },
    })
    expect(readFileSync(
      settings,
      'utf8',
    )).not.toContain('othrys-hook.sh')
    expect(readFileSync(
      settings,
      'utf8',
    )).toContain('echo unrelated')
  },
)

it.each([
  { platform: 'darwin' },
  { platform: 'linux' },
] as const)(
  'finds the existing $platform service through a migrated home alias',
  ({ platform }) => {
    const userHome = join(
      root,
      `service-${platform}`,
    )
    const legacy = join(
      userHome,
      '.pnyx',
    )
    const current = join(
      userHome,
      '.othrys',
    )
    mkdirSync(
      legacy,
      { recursive: true },
    )
    symlinkSync(
      legacy,
      current,
      'dir',
    )
    vi.stubEnv(
      'OTHRYS_HOME',
      current,
    )
    const folder = platform === 'darwin' ? join(
      userHome,
      'Library',
      'LaunchAgents',
    ) : join(
      userHome,
      '.config',
      'systemd',
      'user',
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    const newService = serviceFile({
      userHome,
      platform,
    })
    const label = 'local.pnyx.server.0123456789abcdef'
    const path = join(
      folder,
      `${label}.${platform === 'darwin' ? 'plist' : 'service'}`,
    )
    const content = platform === 'darwin' ? `<key>PNYX_HOME</key><string>${legacy}</string><key>ProgramArguments</key><array><string>serve</string></array>` : `Environment="PNYX_HOME=${legacy}"\nExecStart=node cli.js serve\n`
    writeFileSync(
      path,
      content,
    )
    expect(serviceFile({
      userHome,
      platform,
    })).toEqual({
      label,
      path,
    })
    const preview = setupService({
      userHome,
      platform,
      preview: true,
      searchPath: '',
      environment: {},
    })
    expect(preview.path).toBe(path)
    expect(readFileSync(
      path,
      'utf8',
    )).toBe(content)
    writeFileSync(
      newService.path,
      content,
    )
    expect(() => setupService({
      userHome,
      platform,
      preview: true,
      searchPath: '',
      environment: {},
    })).toThrow('Multiple login services')
  },
)

it(
  'legacy hook environment still reports to its assigned Titan and task',
  () => {
    const home = join(
      root,
      'legacy-hook-env',
    )
    const spool = join(
      home,
      'hydras',
      'saved',
      'spool',
    )
    mkdirSync(
      spool,
      { recursive: true },
    )
    const script = new URL(
      '../setup/hooks/othrys-hook.sh',
      import.meta.url,
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PNYX_HOME: home,
      PNYX_HYDRA: 'saved',
      PNYX_TASK: 'task-saved',
    }
    delete env.OTHRYS_HOME
    delete env.OTHRYS_TITAN
    delete env.OTHRYS_TASK
    execFileSync(
      'sh',
      [
        script.pathname,
        'claude',
        'Stop',
      ],
      {
        env,
        input: '{}',
      },
    )
    const files = readdirSync(spool)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(
      join(
        spool,
        files[0]!,
      ),
      'utf8',
    ))).toMatchObject({
      task: 'task-saved',
      event: 'Stop',
    })
    expect(existsSync(join(
      home,
      'hydras',
      'default',
    ))).toBe(false)
  },
)

it.each([
  { installed: 'pnyx' },
  { installed: 'othrys' },
])(
  'retires owned legacy skill links from a $installed install while preserving custom new-name skills',
  ({ installed }) => {
    const userHome = join(
      root,
      `skill-links-${installed}`,
    )
    const global = join(
      userHome,
      '.agents',
      'skills',
    )
    const previousInstall = join(
      userHome,
      'old-install',
    )
    const oldSkill = join(
      previousInstall,
      'skills',
      'pnyx-cli',
    )
    mkdirSync(
      oldSkill,
      { recursive: true },
    )
    mkdirSync(
      global,
      { recursive: true },
    )
    writeFileSync(
      join(
        previousInstall,
        'package.json',
      ),
      JSON.stringify({ name: installed }),
    )
    writeFileSync(
      join(
        oldSkill,
        'SKILL.md',
      ),
      'old shipped skill',
    )
    const oldLink = join(
      global,
      'pnyx-cli',
    )
    symlinkSync(
      oldSkill,
      oldLink,
      'dir',
    )
    const custom = join(
      global,
      'othrys-cli',
    )
    mkdirSync(custom)
    writeFileSync(
      join(
        custom,
        'SKILL.md',
      ),
      'owner custom skill',
    )
    setupSkills({
      userHome,
      claudeConfigDir: join(
        userHome,
        '.claude',
      ),
    })
    expect(existsSync(oldLink)).toBe(false)
    expect(readFileSync(
      join(
        custom,
        'SKILL.md',
      ),
      'utf8',
    )).toBe('owner custom skill')
    expect(existsSync(join(
      global,
      'othrys-report-progress',
      'SKILL.md',
    ))).toBe(true)
  },
)

test(
  'both legacy executable paths still start the rebranded CLI',
  () => {
    for (const name of [
      'pnyx.js',
      'pnyx-axi.js',
    ]) {
      const output = execFileSync(
        join(
          dirname(CLI),
          name,
        ),
        ['--help'],
        {
          env: process.env,
          encoding: 'utf8',
        },
      )
      expect(output).toContain('usage: othrys')
    }
  },
)

test(
  'new environment values take precedence while legacy identities and homes remain inputs',
  () => {
    expect(compatibleEnvironment({
      env: {
        PNYX_HOME: '/old',
        OTHRYS_HOME: '/new',
        PNYX_HYDRA: 'west',
        PNYX_ACTOR: 'worker:task',
        PNYX_TASK: 'task',
        PNYX_STEERING_WORKER: 'session',
        PNYX_WORKER_HOME: '/captured',
      },
    })).toMatchObject({
      OTHRYS_HOME: '/new',
      OTHRYS_TITAN: 'west',
      OTHRYS_ACTOR: 'worker:task',
      OTHRYS_TASK: 'task',
      OTHRYS_STEERING_WORKER: 'session',
      OTHRYS_WORKER_HOME: '/captured',
    })
  },
)

test(
  'a source-installed legacy login service can still invoke its saved CLI entry',
  () => {
    const output = execFileSync(
      process.execPath,
      [
        '--conditions=source',
        join(
          import.meta.dirname,
          '..',
          'src',
          'cli',
          'pnyx.ts',
        ),
        '--help',
      ],
      {
        env: process.env,
        encoding: 'utf8',
      },
    )
    expect(output).toContain('usage: othrys')
  },
)

test(
  'reopens a pending send saved under the legacy key and keeps updating that record',
  () => {
    const attempt = {
      text: 'My unsent draft',
      id: 'saved-attempt',
      pending: true,
    }
    const records = new Map([
      [
        'pnyx:west:send:chat',
        JSON.stringify(attempt),
      ],
    ])
    vi.stubGlobal(
      'sessionStorage',
      {
        getItem: records.get.bind(records),
        setItem: records.set.bind(records),
        removeItem: records.delete.bind(records),
      },
    )
    expect(readAttempt({
      hydraId: 'west',
      key: 'chat',
    })).toEqual(attempt)
    saveAttempt({
      hydraId: 'west',
      key: 'chat',
      attempt: {
        ...attempt,
        pending: false,
      },
    })
    expect(JSON.parse(records.get('pnyx:west:send:chat')!)).toEqual({
      ...attempt,
      pending: false,
    })
    expect(records.has('othrys:west:send:chat')).toBe(false)
  },
)

test(
  'restores a saved task editor draft and keeps editing its existing browser record',
  async () => {
    const origin = 'http://example.test'
    const installation = 'saved-installation'
    const savedKey = `pnyx:view:${JSON.stringify([
      origin,
      installation,
      'task',
      'west:task-saved',
      'editor.title',
    ])}`
    const records = new Map([
      [
        savedKey,
        JSON.stringify('My saved task title'),
      ],
    ])
    vi.stubGlobal(
      'addEventListener',
      vi.fn(),
    )
    vi.stubGlobal(
      'document',
      { querySelector: () => ({ content: installation }) },
    )
    vi.stubGlobal(
      'location',
      { origin },
    )
    vi.stubGlobal(
      'sessionStorage',
      {
        getItem: records.get.bind(records),
        setItem: records.set.bind(records),
        removeItem: records.delete.bind(records),
      },
    )
    const {
      sessionView,
      sessionViewKey,
    } = await import('#web-app/session-view.ts')
    const view = sessionView({
      key: sessionViewKey({
        scope: 'task',
        id: 'west:task-saved',
        field: 'editor.title',
      }),
      initial: 'Published task title',
    })
    expect(view.snapshot()).toBe('My saved task title')
    view.set('My revised draft')
    expect(JSON.parse(records.get(savedKey)!)).toBe('My revised draft')
  },
)
