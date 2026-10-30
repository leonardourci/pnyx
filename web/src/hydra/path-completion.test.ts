import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completePath } from './path-completion.ts'

const folders = ({ names }: { names: string[] }) => names.map(name => ({
  name,
  path: `/home/ana/${name}`,
}))

test(
  'Tab completes a typed path like a shell and leaves a complete path for the next Tab',
  () => {
    assert.equal(
      completePath({
        typed: '~/pro',
        listing: {
          folders: folders({ names: ['projects'] }),
          recent: [],
        },
      }),
      '~/projects/',
    )
    assert.equal(
      completePath({
        typed: '~/p',
        listing: {
          folders: folders({
            names: [
              'pnyx',
              'pnyx-site',
            ],
          }),
          recent: [],
        },
      }),
      '~/pnyx',
    )
    assert.equal(
      completePath({
        typed: '~/pnyx',
        listing: {
          folders: folders({
            names: [
              'pnyx',
              'pnyx-site',
            ],
          }),
          recent: [],
          selected: {
            name: 'pnyx',
            path: '/home/ana/pnyx',
            empty: false,
          },
        },
      }),
      undefined,
    )
    assert.equal(
      completePath({
        typed: '~/zz',
        listing: {
          folders: [],
          recent: [],
        },
      }),
      undefined,
    )
  },
)
