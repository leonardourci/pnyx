import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderSuggestions } from './mention-folders.ts'

const attached = [
  {
    name: 'billing',
    path: '/code/billing',
    detached: false,
  },
]
const otherProjects = [
  {
    name: 'billing',
    path: '/code/billing',
    hydra: 'Eos',
  },
  {
    name: 'billing-api',
    path: '/code/billing-api',
    hydra: 'Eos',
  },
  {
    name: 'web',
    path: '/code/web',
    hydra: 'Eos',
  },
]
const listing = {
  recent: [
    {
      name: 'billing-docs',
      path: '/code/billing-docs',
    },
  ],
  folders: [
    {
      name: 'billing-old',
      path: '/code/billing-old',
    },
  ],
}

test(
  'a pasted clone URL offers to clone that repository',
  () => {
    assert.deepEqual(
      folderSuggestions({
        query: '',
        typed: 'https://github.com/acme/billing.git',
        attached: [],
        otherProjects: [],
        typedPath: false,
      }),
      [
        {
          key: 'clone:https://github.com/acme/billing.git',
          kind: 'project',
          title: 'Clone billing',
          detail: 'https://github.com/acme/billing.git',
          icons: ['clone'],
          group: 'Folders',
          insert: 'https://github.com/acme/billing.git',
          path: 'https://github.com/acme/billing.git',
        },
      ],
    )
  },
)

test(
  'the @ picker offers matching projects of other Hydras and recent folders, but not what is already attached',
  () => {
    const items = folderSuggestions({
      query: 'bill',
      typed: 'bill',
      attached,
      otherProjects,
      listing,
      typedPath: false,
    })

    assert.deepEqual(
      items.map(({
        key,
        detail,
      }) => [
        key,
        detail,
      ]),
      [
        [
          'folder:/code/billing-api',
          'In Eos',
        ],
        [
          'folder:/code/billing-docs',
          '/code/billing-docs',
        ],
      ],
    )
  },
)

test(
  'a typed path lists only the folders under it',
  () => {
    const items = folderSuggestions({
      query: 'bill',
      typed: '/code/',
      attached,
      otherProjects,
      listing,
      typedPath: true,
    })

    assert.deepEqual(
      items.map(item => item.key),
      [
        'folder:/code/billing-docs',
        'folder:/code/billing-old',
      ],
    )
  },
)
