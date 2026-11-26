import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { filterRows, prepareRow } from '#titan/suggestion-matches.ts'
import { typedListing } from '#web-titan/mention-folders.ts'
import { completePath } from '#web-titan/path-completion.ts'
import { startOthrys, until, type Othrys } from './setup/othrys.ts'
import { createProject } from './setup/projects.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

interface ModelsAnswer {
  models?: { value: string }[]
}

const values = ({ answer }: { answer: unknown }) => ((answer as ModelsAnswer).models ?? [])
  .map(model => model.value)

test(
  'models --refresh asks the harness again and keeps the list it had when that fails',
  async () => {
    const hydra = await othrys.hydra()
    const page = await hydra.page()
    const recorded = othrys.claude.models.list

    try {
      expect(values({
        answer: await page.send({
          name: 'models',
          args: ['claude'],
        }),
      })).toContain('haiku')
      othrys.claude.models.list = [
        ...recorded.filter(model => model.value !== 'haiku'),
        {
          value: 'claude-lyra-1',
          displayName: 'Lyra',
          description: 'A model the harness started listing',
        },
      ]
      expect(values({
        answer: await page.send({
          name: 'models',
          args: ['claude'],
        }),
      })).toContain('haiku')

      const refreshed = values({
        answer: await page.send({
          name: 'models',
          args: [
            'claude',
            '--refresh',
          ],
        }),
      })
      expect(refreshed).toContain('claude-lyra-1')
      expect(refreshed).not.toContain('haiku')

      othrys.claude.models.failure = 'Claude Code could not list its models'
      expect(await page.send({
        name: 'models',
        args: [
          'claude',
          '--refresh',
        ],
      })).toMatchObject({
        type: 'error',
        code: 'CATALOG_UNAVAILABLE',
      })
      expect(values({
        answer: await page.send({
          name: 'models',
          args: ['claude'],
        }),
      })).toEqual(refreshed)
    } finally {
      othrys.claude.models.failure = undefined
      othrys.claude.models.list = recorded
      page.close()
    }
  },
)

test(
  'title matches rank before fallback matches, then matches at the start, then words that start a word',
  () => {
    const rows = [
      prepareRow({
        item: {
          key: 'prompt',
          title: 'Water the plants',
        },
        fallback: 'Ship it on Friday',
      }),
      ...[
        {
          key: 'inside',
          title: 'Reship the build',
        },
        {
          key: 'word',
          title: 'Then ship the build',
        },
        {
          key: 'start',
          title: 'Shipping notes',
        },
      ].map(item => prepareRow({ item })),
    ]

    expect(filterRows({
      rows,
      query: 'ship',
    }).map(match => match.row.item.key)).toEqual([
      'start',
      'word',
      'inside',
      'prompt',
    ])
    expect(filterRows({
      rows,
      query: 'build reship',
    }).map(match => ({
      key: match.row.item.key,
      ranges: match.ranges.length,
    }))).toEqual([
      {
        key: 'inside',
        ranges: 11,
      },
    ])
  },
)

test(
  'a match marks each matched character once, also one that splits into several letters',
  () => {
    const rows = [
      prepareRow({
        item: {
          key: 'korean',
          title: '한국어 노트',
        },
      }),
    ]

    expect(filterRows({
      rows,
      query: '한국',
    }).map(match => match.ranges)).toEqual([
      [
        {
          from: 0,
          to: 1,
        },
        {
          from: 1,
          to: 2,
        },
      ],
    ])
  },
)

interface FilesAnswer {
  projects?: {
    path: string
    files: string[]
  }[]
}

test(
  'files lists each attached project\'s files without ignored ones, and again after a file appears',
  async () => {
    const hydra = await othrys.hydra()
    const path = await createProject({
      hydra,
      landing: 'branch',
    })
    writeFileSync(
      join(
        path,
        '.gitignore',
      ),
      'build/\n',
    )
    mkdirSync(join(
      path,
      'build',
    ))
    writeFileSync(
      join(
        path,
        'build',
        'out.js',
      ),
      '',
    )
    const page = await hydra.page()

    const files = async () => {
      const answer = await page.send({
        name: 'files',
        args: [],
      }) as FilesAnswer

      return answer.projects?.[0]?.files ?? []
    }

    try {
      await until({
        what: 'the project files',
        check: async () => (await files()).includes('.gitignore'),
      })
      expect(await files()).toEqual([
        '.gitignore',
        'README.md',
      ])
      mkdirSync(join(
        path,
        'notes',
      ))
      writeFileSync(
        join(
          path,
          'notes',
          'plan.md',
        ),
        'plan\n',
      )
      await until({
        what: 'the new file listed',
        check: async () => (await files()).includes('notes/plan.md'),
      })
    } finally {
      page.close()
    }
  },
)

test(
  'a folder listing with files names every entry, hidden ones included',
  async () => {
    const hydra = await othrys.hydra()
    const folder = hydra.folder({ name: 'loose' })
    mkdirSync(join(
      folder,
      'src',
    ))
    mkdirSync(join(
      folder,
      '.config',
    ))
    writeFileSync(
      join(
        folder,
        'notes.txt',
      ),
      '',
    )

    const listing = async ({ files }: { files: boolean }) => {
      const query = new URLSearchParams({
        path: `${folder}/`,
        ...files ? { files: '1' } : {},
      })
      const response = await fetch(`http://127.0.0.1:${othrys.port()}/hydra/${hydra.id}/folders?${query}`)

      return await response.json() as {
        folders: { name: string }[]
        files?: { name: string }[]
      }
    }

    const full = await listing({ files: true })
    expect(full.folders.map(entry => entry.name)).toEqual([
      '.config',
      'src',
    ])
    expect(full.files?.map(entry => entry.name)).toEqual(['notes.txt'])
    const plain = await listing({ files: false })
    expect(plain.folders.map(entry => entry.name)).toEqual(['src'])
    expect(plain.files).toBeUndefined()
  },
)

test(
  'a typed name narrows its folder\'s contents, and Tab completes only from contents listed in full',
  () => {
    const entries = ({ names }: { names: string[] }) => names.map(name => ({
      name,
      path: `/work/${name}`,
    }))
    const contents = {
      folders: entries({
        names: [
          '.cache',
          'app-api',
          'app-web',
          'docs',
        ],
      }),
      files: entries({
        names: [
          '.env',
          'apply.md',
        ],
      }),
      recent: [],
    }

    const shown = ({ name }: { name: string }) => {
      const listing = typedListing({
        listing: contents,
        name,
      })

      return [
        ...listing.folders,
        ...listing.files ?? [],
      ].map(entry => entry.name)
    }

    expect(shown({ name: '' })).toEqual([
      'app-api',
      'app-web',
      'docs',
      'apply.md',
    ])
    expect(shown({ name: 'APP' })).toEqual([
      'app-api',
      'app-web',
      'apply.md',
    ])
    expect(shown({ name: '.' })).toEqual([
      '.cache',
      '.env',
    ])
    expect(completePath({
      typed: '/work/app',
      contents,
    })).toBe('/work/app-')

    const capped = {
      folders: entries({
        names: Array.from(
          { length: 1000 },
          (
            _,
            index,
          ) => `pkg-${String(index).padStart(
            4,
            '0',
          )}-src`,
        ),
      }),
      recent: [],
    }
    expect(typedListing({
      listing: capped,
      name: 'pkg-0999',
    }).folders.map(entry => entry.name)).toEqual(['pkg-0999-src'])
    expect(completePath({
      typed: '/work/pkg-0999',
      contents: capped,
    })).toBeUndefined()
  },
)
