import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHOWN_IMAGE, attachedImages, imageNames, shownImageLabel, shownImageNames } from './images.ts'

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

test(
  'a bare path keeps its file name even where the same path is also a numbered token',
  () => {
    const text = 'Compare /home/.pnyx/hydras/dev/copies/task/shot.png then [image: /home/.pnyx/hydras/dev/copies/task/shot.png]'
    const names = shownImageNames({ text })
    assert.deepEqual(
      [...text.matchAll(SHOWN_IMAGE)].map(match => shownImageLabel({
        match,
        names,
      })),
      [
        'shot.png',
        'Image 1',
      ],
    )
  },
)

test(
  'a screenshot path with parentheses, a quoted or escaped space, or a .jpeg extension is an image too',
  () => {
    assert.deepEqual(
      [
        ...shownImageNames({
          text: 'See /tmp/test(1).png, "/tmp/My Folder/Screen Shot 2026.png", /tmp/My\\ Shots/a\\ b.png and /tmp/photo.jpeg, then /tmp/a and b.png',
        }).keys(),
      ],
      [
        '/tmp/test(1).png',
        '/tmp/My Folder/Screen Shot 2026.png',
        '/tmp/My Shots/a b.png',
        '/tmp/photo.jpeg',
      ],
    )
  },
)
