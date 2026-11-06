import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mentionCandidates } from './mention-candidates.ts'

test(
  'a typed folder leads the @ matches once, and detached projects are not offered',
  () => {
    const typedFolder = {
      key: 'folder:/code/billing-api',
      kind: 'project' as const,
      title: 'billing-api',
      detail: '/code/billing-api',
      group: 'Folders',
      insert: '/code/billing-api',
      path: '/code/billing-api',
    }
    const matches = mentionCandidates({
      query: 'bill',
      view: { chips: [] },
      projects: [
        {
          name: 'billing',
          path: '/code/billing',
          detached: false,
        },
        {
          name: 'billing-old',
          path: '/code/billing-old',
          detached: true,
        },
      ],
      columns: [],
      cards: [],
      taskLook: () => ({
        icons: [],
        tone: '',
      }),
      folderItems: [typedFolder],
      typedFolder,
    })

    assert.deepEqual(
      matches.map(item => item.key),
      [
        'folder:/code/billing-api',
        'project:/code/billing',
      ],
    )
  },
)
