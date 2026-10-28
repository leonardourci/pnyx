import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reference, taskMention } from '#hydra/mentions.ts'
import { copyDraft, snapSelection, draftView, editDraft, CHIP_SPACE, CHIP_JOIN, WORD_JOINER, ICON_SPACE, hasPendingImage, pendingImage, placeImages, replaceDisplay, settleImage, withoutPendingImages } from './draft.ts'

const task = taskMention({
  id: 'task-1',
  title: 'Fix [login]',
})
const image = '[image: /home/hydras/default/attachments/a.png]'
const other = '[image: /home/hydras/default/attachments/b.png]'
// A task chip shows as its card and state icons, then its title.
const label = `${CHIP_SPACE}${ICON_SPACE}${WORD_JOINER}${ICON_SPACE}${CHIP_JOIN}Fix [login]${CHIP_SPACE}`

test(
  'typing next to a chip keeps it and an edit that touches it removes it whole',
  () => {
    const text = `Hi ${task} there`
    const typed = editDraft({
      text,
      next: `Hi ${label}! there`,
      caret: `Hi ${label}!`.length,
    })
    assert.deepEqual(
      typed,
      {
        text: `Hi ${task}! there`,
        caret: `Hi ${label}!`.length,
      },
    )
    const erased = editDraft({
      text,
      next: `Hi ${label.slice(
        0,
        -1,
      )} there`,
      caret: `Hi ${label}`.length - 1,
    })
    assert.deepEqual(
      erased,
      {
        text: 'Hi  there',
        caret: 3,
      },
    )
    assert.deepEqual(
      replaceDisplay({
        text,
        from: 5,
        to: 5,
        insert: 'x',
      }),
      {
        text: 'Hi x there',
        caret: 4,
      },
    )
  },
)

test(
  'a character typed next to the same character keeps the caret right after it',
  () => {
    assert.deepEqual(
      editDraft({
        text: 'a b',
        next: 'a  b',
        caret: 2,
      }),
      {
        text: 'a  b',
        caret: 2,
      },
    )
    const text = `I think ${image} the end`
    const at = draftView({ text }).chips[0]!.to
    const typed = draftView({ text }).display
    assert.equal(
      editDraft({
        text,
        next: `${typed.slice(
          0,
          at,
        )} ${typed.slice(at)}`,
        caret: at + 1,
      }).caret,
      at + 1,
    )
  },
)

test(
  'an image lands at the caret inside the sentence, never inside a word, and its card comes out whole',
  () => {
    const shown = ({ text }: { text: string }) => draftView({ text }).display
    const place = ({
      text,
      at,
      lines = [image],
    }: {
      text: string
      at: string
      lines?: string[]
    }) => placeImages({
      text,
      caret: text.indexOf(at) + at.length,
      lines,
    })
    const midWord = place({
      text: 'I think it could have a preview',
      at: 'I thi',
    })
    assert.equal(
      midWord.text,
      `I think ${image} it could have a preview`,
    )
    assert.equal(
      shown({ text: midWord.text }).slice(midWord.caret),
      ' it could have a preview',
    )
    assert.equal(
      place({
        text: 'In, the attachment is too large',
        at: 'In',
      }).text,
      `In ${image}, the attachment is too large`,
    )
    const end = place({
      text: 'Keep it small like',
      at: 'like',
      lines: [
        image,
        other,
      ],
    })
    assert.equal(
      end.text,
      `Keep it small like ${image} ${other} `,
    )
    assert.equal(
      end.caret,
      shown({ text: end.text }).length,
    )
    assert.equal(
      place({
        text: 'First line\nsecond',
        at: 'First line\n',
      }).text,
      `First line\n${image} second`,
    )
    assert.equal(
      place({
        text: 'café 𝒜𝒷𝒸 done',
        at: 'café 𝒜𝒷',
      }).text,
      `café 𝒜𝒷𝒸 ${image} done`,
    )
    assert.equal(
      place({
        text: "I don't use snake_case or 3.14 here",
        at: 'I do',
      }).text,
      `I don't ${image} use snake_case or 3.14 here`,
    )
    assert.equal(
      place({
        text: 'snake_case and 3.14',
        at: 'sna',
      }).text,
      `snake_case ${image} and 3.14`,
    )
    assert.equal(
      place({
        text: 'pi is 3.14 today',
        at: 'pi is 3.',
      }).text,
      `pi is 3.14 ${image} today`,
    )
    const japanese = place({
      text: 'これは画像です。',
      at: 'これは画',
    }).text
    assert.ok(japanese.startsWith('これは画像'))
    assert.ok(!japanese.endsWith(`${image} 。`))
    assert.equal(
      place({
        text: 'ok 👍👍 go',
        at: 'ok 👍',
      }).text,
      `ok 👍 ${image} 👍 go`,
    )
  },
)

test(
  'an image keeps its place while it uploads and the owner keeps typing; send waits until it becomes the stored image there',
  () => {
    const shown = ({ text }: { text: string }) => draftView({ text }).display
    const path = pendingImage({ id: 'p1' })
    const placed = placeImages({
      text: 'here is what I see',
      lines: [`[image: ${path}]`],
    })
    const typed = `${placed.text}and tell me`
    assert.equal(
      draftView({ text: typed }).chips[0]!.name,
      'Loading image 1',
    )
    assert.ok(hasPendingImage({ text: typed }))

    const settled = settleImage({
      text: typed,
      caret: shown({ text: typed }).length,
      path,
      line: image,
    })
    assert.deepEqual(
      settled,
      {
        text: `here is what I see ${image} and tell me`,
        caret: shown({ text: `here is what I see ${image} and tell me` }).length,
      },
    )
    assert.equal(
      draftView({ text: settled.text }).chips[0]!.name,
      'Image 1',
    )
    assert.equal(
      hasPendingImage({ text: settled.text }),
      false,
    )
    assert.equal(
      settleImage({
        text: typed,
        caret: 4,
        path,
        line: image,
      })?.caret,
      4,
    )
  },
)

test(
  'a failed upload removes its placeholder and keeps what the owner typed; a removed placeholder drops the image',
  () => {
    const path = pendingImage({ id: 'p1' })
    const typed = `here is what I see [image: ${path}] and tell me`
    const failed = settleImage({
      text: typed,
      caret: draftView({ text: typed }).display.length,
      path,
    })
    assert.deepEqual(
      failed,
      {
        text: 'here is what I see and tell me',
        caret: 'here is what I see and tell me'.length,
      },
    )
    assert.equal(
      settleImage({
        text: 'here is what I see and tell me',
        caret: 0,
        path,
        line: image,
      }),
      undefined,
    )
  },
)

test(
  'a draft restored after a reload loses the placeholders of uploads that never finished',
  () => {
    assert.equal(
      withoutPendingImages({ text: `see [image: ${pendingImage({ id: 'p1' })}] and ${other} too` }),
      `see and ${other} too`,
    )
  },
)

test(
  'two images uploading together keep their numbers and places whichever answers first',
  () => {
    const first = pendingImage({ id: 'p1' }), second = pendingImage({ id: 'p2' })
    const text = `before [image: ${first}] middle [image: ${second}] after`
    assert.deepEqual(
      draftView({ text }).chips.map(chip => chip.name),
      [
        'Loading image 1',
        'Loading image 2',
      ],
    )
    const later = settleImage({
      text,
      caret: 0,
      path: second,
      line: other,
    })!
    const both = settleImage({
      text: later.text,
      caret: 0,
      path: first,
      line: image,
    })!
    assert.equal(
      both.text,
      `before ${image} middle ${other} after`,
    )
    assert.deepEqual(
      draftView({ text: both.text }).chips.map(chip => chip.name),
      [
        'Image 1',
        'Image 2',
      ],
    )
  },
)

test(
  'a mention of an image still loading is not taken for its placeholder',
  () => {
    const path = pendingImage({ id: 'p1' })
    const mention = reference({
      kind: 'image',
      value: path,
      label: 'Loading image 1',
    })
    const text = `${mention} see [image: ${path}]`
    assert.equal(
      settleImage({
        text,
        caret: 0,
        path,
        line: image,
      })?.text,
      `${mention} see ${image}`,
    )
  },
)

test(
  'copied chips come back as chips when pasted, and read as their names in other apps',
  () => {
    const skill = reference({
      kind: 'skill',
      label: '/review-code',
      value: JSON.stringify({ name: 'review-code' }),
    })
    const text = `Can you run ${skill} on ${task} here ${image} please`
    const shown = draftView({ text }).display
    const copied = copyDraft({
      text,
      from: shown.indexOf('run'),
      to: shown.indexOf('please'),
    })!
    assert.equal(
      copied.source,
      `run ${skill} on ${task} here ${image} `,
    )
    assert.equal(
      copied.plain,
      'run /review-code on Fix [login] here Image 1 ',
    )
    const pasted = replaceDisplay({
      text: 'Again: ',
      from: 'Again: '.length,
      to: 'Again: '.length,
      insert: copied.source,
    })
    assert.deepEqual(
      draftView({ text: pasted.text }).chips.map(chip => chip.kind),
      [
        'skill',
        'task',
        'image',
      ],
    )

    const skillChip = draftView({ text }).chips[0]!
    const taskChip = draftView({ text }).chips[1]!
    assert.equal(
      copyDraft({
        text,
        from: skillChip.from + 3,
        to: taskChip.to - 3,
      })?.source,
      `${skill} on ${task}`,
    )
    assert.equal(
      copyDraft({
        text,
        from: 0,
        to: 'Can you'.length,
      }),
      undefined,
    )
    assert.equal(
      copyDraft({
        text: `see [image: ${pendingImage({ id: 'p1' })}] and ${image}`,
        from: 0,
        to: draftView({ text: `see [image: ${pendingImage({ id: 'p1' })}] and ${image}` }).display.length,
      })?.source,
      `see and ${image}`,
    )
  },
)

test(
  'a selection steps over a chip in one move, and an end left inside a chip takes the whole chip',
  () => {
    const text = `${task} waits here`
    const view = draftView({ text })
    const chip = view.chips[0]!
    assert.deepEqual(
      snapSelection({
        view,
        anchor: view.display.length,
        focus: chip.to - 1,
        previous: chip.to,
      }),
      {
        anchor: view.display.length,
        focus: chip.from,
      },
    )
    assert.deepEqual(
      snapSelection({
        view,
        anchor: chip.from + 2,
        focus: view.display.length,
        previous: view.display.length - 1,
      }),
      {
        anchor: chip.from,
        focus: view.display.length,
      },
    )
    assert.deepEqual(
      snapSelection({
        view,
        anchor: chip.from + 2,
        focus: chip.from + 2,
        previous: chip.from + 1,
      }),
      {
        anchor: chip.to,
        focus: chip.to,
      },
    )
  },
)
