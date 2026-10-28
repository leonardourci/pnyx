import { taskMention } from '#hydra/mentions.ts'
import { DRAFT_TYPE } from './draft.ts'
import { MESSAGE_DECORATIONS } from './message-selection.ts'

// Each chip in a rendered message keeps the Markdown it came from, so a copy can bring the chip back.
export const CHIP_SOURCE = 'data-chip-source'

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
  host.querySelectorAll('.message-lead').forEach(lead => lead.replaceWith(
    ...lead.childNodes,
    ' ',
  ))
  document.body.append(host)
  const text = host.innerText
  host.remove()

  return text
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

// A selection holding chips copies their Markdown under the composer's type; other apps read the chips' names.
export function copyMessageChips({
  selection,
  clipboard,
}: {
  selection: Selection | null
  clipboard: DataTransfer
}) {
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined

  if (!range || range.collapsed || !range.cloneContents().querySelector(CHIPS)) {
    return false
  }

  clipboard.setData(
    DRAFT_TYPE,
    selectedText({
      range,
      chip: chipMarkdown,
    }),
  )
  clipboard.setData(
    'text/plain',
    selectedText({
      range,
      chip: chipName,
    }),
  )

  return true
}
