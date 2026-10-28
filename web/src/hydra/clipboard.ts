import { taskMention } from '#hydra/mentions.ts'
import { imagePaths } from '#hydra/images.ts'
import { shownImageData } from './attached-image.tsx'
import { CHIP_SOURCE, MESSAGE_DECORATIONS } from './message-selection.ts'

// A task message's leading chip comes from its task id, not its text, so it is rebuilt from the chip.
const CHIPS = `[${CHIP_SOURCE}], .message-lead [data-task-ref]`
const LEFT_OUT = `${MESSAGE_DECORATIONS}, .message-images`
const ROOM = /[\u2003\u2005\u2060]/g

// innerText keeps the breaks between blocks but needs layout, so the copy is read off screen.
function selectedText({
  range,
  chip,
}: {
  range: Range
  chip({ element }: { element: Element }): string
}) {
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: -10000px; top: 0; white-space: pre-wrap'
  host.append(range.cloneContents())
  host.querySelectorAll(LEFT_OUT).forEach(element => element.remove())
  host.querySelectorAll(CHIPS).forEach(element => element.replaceWith(chip({ element })))

  // The leading chip goes where it shows: at the start of the message's first paragraph.
  for (const lead of host.querySelectorAll('.message-lead')) {
    const paragraph = lead.nextElementSibling?.matches('.markdown')
      ? lead.nextElementSibling.querySelector(':scope > .message-block:first-child > p:first-child')
      : null

    if (paragraph) {
      paragraph.prepend(
        ...lead.childNodes,
        ' ',
      )
      lead.remove()
    } else {
      lead.replaceWith(...lead.childNodes)
    }
  }

  document.body.append(host)
  const text = host.innerText
  host.remove()

  return text.replace(
    /^\n+|\n+$/g,
    '',
  )
}

const chipName = ({ element }: { element: Element }) => (element.textContent ?? '').replace(
  ROOM,
  '',
).replace(
  /\u00a0/g,
  ' ',
)
  .trim()

const chipMarkdown = ({ element }: { element: Element }) => element.getAttribute(CHIP_SOURCE)
  ?? taskMention({
    id: element.getAttribute('data-task-ref') ?? '',
    title: chipName({ element: element.querySelector('.task-reference-title') ?? element }),
  })

// An embedded image is a private-use mark while the copy is plain text, so escaping can't touch it.
const IMAGE_MARK = /\uE000(\d+)\uE001/g

const escapeHtml = ({ text }: { text: string }) => text.replace(
  /&/g,
  '&amp;',
).replace(
  /</g,
  '&lt;',
)
  .replace(
    />/g,
    '&gt;',
  )
  .replace(
    /"/g,
    '&quot;',
  )

// Each attached image the page has already loaded becomes a mark for imagesHtml; the rest keep their names.
export function embedImages() {
  const images: {
    data: string
    name: string
  }[] = []

  const image = ({
    path,
    name,
  }: {
    path: string
    name: string
  }) => {
    const data = shownImageData({ path })

    if (!data) {
      return name
    }

    images.push({
      data,
      name,
    })

    return `\uE000${images.length - 1}\uE001`
  }

  return {
    images,
    image,
  }
}

// Copied text with its image marks, as HTML that other apps paste with the pictures in place.
export function imagesHtml({
  text,
  images,
}: {
  text: string
  images: ReturnType<typeof embedImages>['images']
}) {
  return escapeHtml({ text }).replace(
    /\n/g,
    '<br>',
  )
    .replace(
      IMAGE_MARK,
      (
        _mark,
        index: string,
      ) => {
        const image = images[Number(index)]!

        return `<img src="${image.data}" alt="${escapeHtml({ text: image.name })}">`
      },
    )
}

// A chip the selection starts or ends inside goes whole, so a selected title still copies its chip; a leading
// chip takes its wrapper, which is what marks it as one.
function wholeChips({ range }: { range: Range }) {
  const chipAround = ({ node }: { node: Node }) => {
    const chip = (node instanceof Element ? node : node.parentElement)?.closest(CHIPS)

    return chip?.closest('.message-lead') ?? chip
  }

  const whole = range.cloneRange()
  const first = chipAround({ node: range.startContainer })
  const last = chipAround({ node: range.endContainer })

  if (first) {
    whole.setStartBefore(first)
  }

  if (last) {
    whole.setEndAfter(last)
  }

  return whole
}

// A selection holding chips copies their references as plain text, as a sent message keeps them, so pasting
// into a composer rebuilds the chips; rich-text apps also get the chips' names with their images.
export function copyMessageChips({
  selection,
  clipboard,
}: {
  selection: Selection | null
  clipboard: DataTransfer
}) {
  const selected = selection?.rangeCount ? selection.getRangeAt(0) : undefined

  if (!selected || selected.collapsed) {
    return false
  }

  const range = wholeChips({ range: selected })

  if (!range.cloneContents().querySelector(CHIPS)) {
    return false
  }

  clipboard.setData(
    'text/plain',
    selectedText({
      range,
      chip: chipMarkdown,
    }),
  )

  const embedded = embedImages()
  const marked = selectedText({
    range,
    chip: ({ element }) => {
      const path = imagePaths({ text: element.getAttribute(CHIP_SOURCE) ?? '' })[0]

      return path ? embedded.image({
        path,
        name: chipName({ element }),
      }) : chipName({ element })
    },
  })

  if (embedded.images.length) {
    clipboard.setData(
      'text/html',
      imagesHtml({
        text: marked,
        images: embedded.images,
      }),
    )
  }

  return true
}
