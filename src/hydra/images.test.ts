import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachedImages, imageNames, shownImageNames } from './images.ts'

const stored = '/home/.pnyx/hydras/default/attachments/0b6e1f3a-2c4d-4e5f-8a9b-0c1d2e3f4a5b.png'

test(
  'shown text names a bare absolute image path by its file and keeps the composer’s token numbers',
  () => {
    const bare = '/Users/owner/.pnyx/hydras/default/copies/pnyx-1/.lavish/icons/alts-crop.png'
    const text = `Compare ${bare}. With [image: ${stored}] and (/tmp/b.gif), again ${bare}`
    assert.deepEqual(
      [...shownImageNames({ text })],
      [
        [
          stored,
          'Image 1',
        ],
        [
          bare,
          'alts-crop.png',
        ],
        [
          '/tmp/b.gif',
          'b.gif',
        ],
      ],
    )
    assert.deepEqual(
      [...imageNames({ text })],
      [
        [
          stored,
          'Image 1',
        ],
      ],
      'the composer numbers the same token the same way',
    )
    assert.deepEqual(
      attachedImages({
        text: `${bare} ${stored}`,
        hydras: '/home/.pnyx/hydras',
      }),
      [],
      'a bare path is never sent to an agent as an image',
    )
  },
)

test(
  'a path inside a URL, a relative or home path, or another extension stays text',
  () => {
    assert.deepEqual(
      [...shownImageNames({ text: 'https://example.com/a.png docs/b.png ./h.png ~/c.png /d.pngx /e.png/f /g.PNG /i.png.bak' })],
      [],
    )
  },
)

test(
  'a path in code or a link target stays literal',
  () => {
    assert.deepEqual(
      [
        ...shownImageNames({
          text: 'Run `open /tmp/a.png`, see [the shot](/tmp/c.png), then /tmp/b.png\n\n```sh\nls /tmp/d.png\n```',
        }),
      ],
      [
        [
          '/tmp/b.png',
          'b.png',
        ],
      ],
    )
  },
)
