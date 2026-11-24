import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, test, vi } from 'vitest'
import { selectHome } from '#store/home.ts'
import { othrysHome } from '#store/paths.ts'
import { othrys } from './setup/othrys.ts'

afterEach(() => vi.unstubAllEnvs())

const fixture = () => mkdtempSync(join(
  process.env.TMPDIR!,
  'rebrand-',
))

it(
  'prefers the new explicit home then the legacy explicit home without migration',
  () => {
    const userHome = fixture()
    const legacy = join(
      userHome,
      '.pnyx',
    )
    mkdirSync(legacy)
    expect(selectHome({
      env: {
        OTHRYS_HOME: '/chosen/new',
        PNYX_HOME: '/chosen/old',
      },
      userHome,
    })).toBe('/chosen/new')
    expect(selectHome({
      env: { PNYX_HOME: legacy },
      userHome,
    })).toBe(legacy)
    expect(existsSync(join(
      userHome,
      '.othrys',
    ))).toBe(false)
  },
)

it(
  'uses the new default for a fresh installation without creating data',
  () => {
    const userHome = fixture()
    expect(selectHome({
      env: {},
      userHome,
    })).toBe(join(
      userHome,
      '.othrys',
    ))
    expect(existsSync(join(
      userHome,
      '.othrys',
    ))).toBe(false)
  },
)

it(
  'aliases an existing home without changing records, sessions or captured absolute paths on repeated startup',
  () => {
    const userHome = fixture()
    const legacy = join(
      userHome,
      '.pnyx',
    )
    const session = join(
      legacy,
      'runtime/tasks/example/session.jsonl',
    )
    const records = {
      'hydras/default/hydra.log': '{"actor":"pnyx","hydra":"default","text":"Keep Pnyx in my notes"}\n',
      'hydras/default/tasks/example/task.log': JSON.stringify({
        transcriptPath: session,
        workerLogDir: join(
          legacy,
          'runtime/tasks/example',
        ),
      }),
      'runtime/tasks/example/session.jsonl': '{"session":"unchanged"}\n',
      'projects/project/events.jsonl': '{"memory":"keep"}\n',
      'owner/poleis/work/memory.jsonl': '{"memory":"owner"}\n',
      'settings.log': '{"accounts":["private"],"preferences":{"theme":"dark"}}\n',
    }

    for (const [
      name,
      content,
    ] of Object.entries(records)) {
      const path = join(
        legacy,
        name,
      )
      mkdirSync(
        join(
          path,
          '..',
        ),
        { recursive: true },
      )
      writeFileSync(
        path,
        content,
      )
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = selectHome({
        env: {},
        userHome,
      })
      expect(readlinkSync(selected)).toBe(legacy)

      for (const [
        name,
        content,
      ] of Object.entries(records)) {
        expect(readFileSync(
          join(
            selected,
            name,
          ),
          'utf8',
        )).toBe(content)
      }

      expect(readFileSync(
        session,
        'utf8',
      )).toContain('unchanged')
    }
  },
)

it(
  'selects the new home when both exist and leaves each untouched',
  () => {
    const userHome = fixture()

    for (const name of [
      '.pnyx',
      '.othrys',
    ]) {
      mkdirSync(join(
        userHome,
        name,
      ))
      writeFileSync(
        join(
          userHome,
          name,
          'marker',
        ),
        name,
      )
    }

    expect(selectHome({
      env: {},
      userHome,
    })).toBe(join(
      userHome,
      '.othrys',
    ))

    for (const name of [
      '.pnyx',
      '.othrys',
    ]) {
      expect(readFileSync(
        join(
          userHome,
          name,
          'marker',
        ),
        'utf8',
      )).toBe(name)
    }
  },
)

it(
  'accepts existing directory symlinks and rejects broken or non-directory targets without overwriting them',
  () => {
    for (const slot of [
      '.pnyx',
      '.othrys',
    ]) {
      for (const kind of [
        'directory',
        'file',
        'missing',
      ]) {
        const userHome = fixture()
        const target = join(
          userHome,
          'target',
        )

        if (kind === 'directory') {
          mkdirSync(target)
        }

        if (kind === 'file') {
          writeFileSync(
            target,
            'preserve',
          )
        }

        const path = join(
          userHome,
          slot,
        )
        symlinkSync(
          target,
          path,
        )

        if (kind === 'directory') {
          expect(selectHome({
            env: {},
            userHome,
          })).toBe(join(
            userHome,
            '.othrys',
          ))
        } else {
          expect(() => selectHome({
            env: {},
            userHome,
          })).toThrow('Cannot select Othrys home')
        }

        expect(readlinkSync(path)).toBe(target)
      }
    }
  },
)

it(
  'refuses an unwritable migration target or parent and preserves old data',
  () => {
    for (const restricted of [
      'legacy',
      'parent',
    ]) {
      const userHome = fixture()
      const legacy = join(
        userHome,
        '.pnyx',
      )
      mkdirSync(legacy)
      writeFileSync(
        join(
          legacy,
          'marker',
        ),
        'preserve',
      )
      const path = restricted === 'legacy' ? legacy : userHome
      chmodSync(
        path,
        0o500,
      )

      try {
        expect(() => selectHome({
          env: {},
          userHome,
        })).toThrow('Cannot select Othrys home')
        expect(existsSync(join(
          userHome,
          '.othrys',
        ))).toBe(false)
        expect(readFileSync(
          join(
            legacy,
            'marker',
          ),
          'utf8',
        )).toBe('preserve')
      } finally {
        chmodSync(
          path,
          0o700,
        )
      }
    }
  },
)

it(
  'resolves the default home through HOME to an existing Pnyx installation',
  () => {
    const userHome = fixture()
    const log = join(
      userHome,
      '.pnyx',
      'hydras',
      'default',
      'hydra.log',
    )
    mkdirSync(
      join(
        log,
        '..',
      ),
      { recursive: true },
    )
    writeFileSync(
      log,
      '{"saved":true}\n',
    )
    vi.stubEnv(
      'HOME',
      userHome,
    )
    vi.stubEnv(
      'OTHRYS_HOME',
      undefined,
    )
    vi.stubEnv(
      'PNYX_HOME',
      undefined,
    )
    expect(othrysHome()).toBe(join(
      userHome,
      '.othrys',
    ))
    expect(readFileSync(
      join(
        othrysHome(),
        'hydras',
        'default',
        'hydra.log',
      ),
      'utf8',
    )).toBe('{"saved":true}\n')
  },
)

test(
  'an invalid default home reports a structured failure without changing the existing file',
  async () => {
    const userHome = mkdtempSync(join(
      process.env.TMPDIR!,
      'invalid-home-',
    ))
    const invalid = join(
      userHome,
      '.othrys',
    )
    writeFileSync(
      invalid,
      'Keep this existing file',
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
    }
    delete env.OTHRYS_HOME
    delete env.PNYX_HOME
    const result = await othrys({
      args: [
        'board',
        '--json',
      ],
      env,
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: 'HOME_MIGRATION_FAILED',
      error: expect.stringContaining('Cannot select Othrys home'),
      help: expect.arrayContaining([expect.stringContaining('OTHRYS_HOME')]),
    })
    const text = await othrys({
      args: ['board'],
      env,
    })
    expect(text.stderr).toMatch(/^HOME_MIGRATION_FAILED: Cannot select Othrys home[^\n]*\n.*OTHRYS_HOME/s)
    expect(readFileSync(
      invalid,
      'utf8',
    )).toBe('Keep this existing file')
  },
)
