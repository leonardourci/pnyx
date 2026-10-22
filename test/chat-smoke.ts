import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { hydraSdk } from './hydra-host-fixture.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { seedWebFixture } from './web-fixture.ts'
import { smokeBrowser } from './browser.ts'

const REVIEW_SPACERS = 18
const reviewSpace = Array.from(
  { length: REVIEW_SPACERS },
  (
    _,
    index,
  ) => `Review spacer ${index}: keep the source passage far from the end so returning to its comment requires scrolling. The remaining checklist continues below.`,
).join('\n\n')

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-chat-smoke-',
))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const markdown = (readFileSync(
  join(
    import.meta.dirname,
    'fixtures/web/chat.md',
  ),
  'utf8',
) + '\n\nRepeat target before **target** after target.\n\nImage caption with ![linked alt](https://example.com/image.png) and literal <em>markup</em> nearby.\n\nCross block beginning with selected words.\n\nCross block ending with another passage.').replace(
  '\n\nCross block beginning',
  `\n\n${reviewSpace}\n\nCross block beginning`,
)
appendFileSync(
  fixture.transcript,
  JSON.stringify({
    type: 'user',
    timestamp: '2026-10-15T10:00:00Z',
    message: { content: 'Review this plan.' },
  }) + '\n',
)
appendFileSync(
  fixture.transcript,
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-15T10:01:00Z',
    message: { content: markdown },
  }) + '\n',
)
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    for (const [
      actor,
      text,
      at,
    ] of [
        [
          'web',
          'Review this plan.',
          '2026-10-15T10:00:00Z',
        ],
        [
          'hydra',
          markdown,
          '2026-10-15T10:01:00Z',
        ],
      ]) {
      const decision = hydraEvent({
        state: writer.state,
        meta: {
          actor: actor!,
          at: at!,
        },
        cardId: '$board',
        change: {
          type: 'hydra.message',
          data: {
            action: 'send',
            text: text!,
            hydra: 'hydra',
          },
        },
      })
      assert.ok('event' in decision); writer.append({ event: decision.event })
    }
  },
})
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
  homes: [fixture.nativeHome],
})
const {
  browser,
  evaluate,
  check,
  eventually,
  click,
  fill,
  press,
  screenshot,
  settle,
  close,
} = smokeBrowser({
  home,
  session: 'pnyx-chat',
})
// Every comment card's note shares one label; the one just opened has focus.
const note = ({ value }: { value: string }) => evaluate({ code: `const el = document.activeElement; if (!el.matches('.comment-card textarea')) throw new Error('No note has focus'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true;` })
const select = ({
  start,
  end,
}: {
  start: number
  end: number
}) => evaluate({ code: `const p = [...document.querySelectorAll('.hydra-chat .message-block p')].find(p => p.textContent.startsWith('A readable paragraph')); const range = document.createRange(); range.setStart(p.firstChild, ${start}); range.setEnd(p.firstChild, ${end}); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true;` })

const advancedSetup = String.raw`
  const h = () => document.querySelector('.hydra-chat .messages')
  const cards = () => [...h().querySelectorAll('.comment-card')]
  const ids = window.commentIds || (window.commentIds = {})

  const card = ({text}) => {
    const found=cards().find(c => c.dataset.commentId===ids[text] || c.querySelector('textarea').value===text)

    if(found){
      ids[text]=found.dataset.commentId
    }

    return found
  }

  const source = ({prefix}) => [...h().querySelectorAll('.message-block p')].find(p => p.textContent.startsWith(prefix))
  const tick = () => new Promise(requestAnimationFrame)

  const point = ({
    paragraph:p,
    offset,
  }) => {
    const walk = document.createTreeWalker(
      p,
      NodeFilter.SHOW_TEXT,
    )

    for(let node=walk.nextNode();node;node=walk.nextNode()) {
      if(offset<=node.length) {
        return {
          node,
          offset,
        }
      }

      offset-=node.length
    }

    throw new Error('Selection outside source')
  }

  const ranges = ({text}) => [...CSS.highlights.get(h().dataset.highlight+'-quote-'+card({text}).dataset.commentId)]
  const emphasis = () => [...(CSS.highlights.get(h().dataset.highlight+'-emphasis') || [])]

  const make = async ({
    prefix,
    from,
    to,
    endPrefix,
    text,
  }) => {
    h().focus({preventScroll:true})
    const first=source({prefix}),last=source({prefix:endPrefix || prefix})
    const a=point({
        paragraph:first,
        offset:from,
      }),b=point({
        paragraph:last,
        offset:to,
      }),r=document.createRange()
    r.setStart(
      a.node,
      a.offset,
    );r.setEnd(
      b.node,
      b.offset,
    )
    getSelection().removeAllRanges();getSelection().addRange(r)
    first.dispatchEvent(new MouseEvent(
      'mouseup',
      {bubbles:true},
    ));await tick()
    const pill=h().querySelector('.comment-pill [aria-label="Comment on selection"]')

    if(!pill){
      throw new Error('Missing comment pill')
    }

    pill.click()
    const note=document.activeElement
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    ).set.call(
      note,
      text,
    )
    note.dispatchEvent(new Event(
      'input',
      {bubbles:true},
    ));await tick()
    h().focus({preventScroll:true});await tick()

    return card({text}).dataset.commentId
  }

  window.commentTest={
    h,
    cards,
    card,
    source,
    tick,
    point,
    ranges,
    emphasis,
    make,
  }

  return true
`

const hover = async ({ label }: { label: string }) => {
  await settle()
  const snapshot = await browser({
    args: [
      'snapshot',
      '--full',
    ],
  })
  const ref = snapshot.match(new RegExp('uid=(\\S+) (?:button|textbox) "' + label + '"'))
  assert.ok(
    ref,
    snapshot,
  )
  await browser({
    args: [
      'hover',
      `@${ref[1]}`,
    ],
  })
}

try {
  await commands.hydra([
    'send',
    '--text',
    'Initialize chat smoke.',
  ])

  for (let attempt = 0; attempt < 100; attempt++) {
    if (loadHydra({ hydraId: 'default' }).state.cards['$hydra']?.sessionActivity === 'finished') {
      break
    }

    await new Promise(resolve => setTimeout(
      resolve,
      20,
    ))
  }

  await browser({
    args: [
      'open',
      server.url,
    ],
  }); await browser({
    args: [
      'resize',
      '1440',
      '1000',
    ],
  }); await browser({
    args: [
      'wait',
      'Needs you',
    ],
  })
  await browser({
    args: [
      'wait',
      'Thread plan',
    ],
  })
  await click({ selector: '.hydra-chat .message-block' })
  await evaluate({ code: 'document.querySelector(".hydra-chat .message-block").scrollIntoView({ block: "start" }); return true;' })
  await screenshot({ name: 'message-section.png' })
  await check({
    condition: '!document.querySelector(".hydra-chat .comment-pill")',
    label: 'clicking a message section shows no comment shortcut hint',
  })
  await evaluate({ code: 'document.querySelector(".hydra-chat .hydra-messages").focus(); return true;' })
  await press({ key: 'c' })
  await check({
    condition: 'document.activeElement.matches(".hydra-chat .comment-card textarea")',
    label: 'C still opens a comment on the active block',
  })
  await press({ key: 'Escape' })
  await check({
    condition: '!document.querySelector(".hydra-chat .comment-card")',
    label: 'Escape removes the empty comment it leaves',
  })
  await check({
    condition: 'document.querySelectorAll(".hydra-chat .markdown h1").length === 1 && !!document.querySelector(".hydra-chat .markdown ul li") && !!document.querySelector(".hydra-chat .markdown ol li") && !!document.querySelector(".hydra-chat .markdown table") && document.querySelectorAll(".hydra-chat .code-block").length === 1',
    label: 'agent reply renders as one complete Markdown document',
  })
  await check({
    condition: '[...document.querySelectorAll(".hydra-chat .messages a")].every(a => a.target === "_blank" && a.relList.contains("noopener") && a.relList.contains("noreferrer") && a.contentEditable === "false")',
    label: 'message links open safely outside the read-only conversation',
  })
  await check({
    condition: '[...document.querySelectorAll(".hydra-chat .markdown a")].some(a => a.href === "https://github.com/example/project/pull/42") && !!document.querySelector(".hydra-chat .markdown code") && !!document.querySelector(".hydra-chat .markdown blockquote")',
    label: 'bare PR links, inline code and quotes render in messages',
  })
  await check({
    condition: '[...document.querySelectorAll(".hydra-chat .markdown")].every(el => el.scrollWidth <= el.clientWidth + 1)',
    label: 'long code and tables stay inside the message width',
  })
  await check({
    condition: '!window.pnyxUnsafe && !document.querySelector(".messages script,.messages img,.messages iframe,.messages [onclick],.messages a[href^=javascript],.messages a[href^=data]") && [...document.querySelectorAll(".hydra-chat .messages a")].some(a => a.href === "https://example.com/plan")',
    label: 'Markdown keeps safe links and cannot execute HTML',
  })
  await check({
    condition: 'document.querySelector(".hydra-chat .message.mine").getBoundingClientRect().right === document.querySelector(".hydra-chat .messages").getBoundingClientRect().right',
    label: 'user bubbles align to the right',
  })
  await evaluate({ code: 'window.input = document.querySelector(".hydra-chat .composer textarea"); return true;' })
  const pill = '.hydra-chat .comment-pill [aria-label="Comment on selection"]'
  const below = '[...document.querySelectorAll(".hydra-chat .message-block")].find(b => b.textContent.startsWith("A readable paragraph")).nextElementSibling.getBoundingClientRect().top'
  await evaluate({ code: `window.below = ${below}; return true;` })
  await select({
    start: 2,
    end: 20,
  })
  await check({
    condition: `!!document.querySelector(${JSON.stringify(pill)}) && ${below} === window.below`,
    label: 'the selection pill floats without moving the text',
  })
  await evaluate({ code: 'document.querySelector(".hydra-chat .comment-pill").scrollIntoView({ block: "center" }); return true;' })
  await screenshot({ name: 'comment-pill.png' })
  await click({ selector: pill })
  await note({ value: 'Explain this phrase.' }); await press({ key: 'Escape' })
  await select({
    start: 2,
    end: 10,
  }); await click({ selector: pill })
  await note({ value: 'What does readable mean?' }); await press({ key: 'Escape' })
  await check({
    condition: 'document.querySelectorAll(".hydra-chat .comment-card").length === 2 && document.querySelector(".hydra-chat .composer-comments").textContent.includes("Comments · 2") && document.querySelector(".hydra-chat .composer textarea") === window.input',
    label: 'nested selections keep independent comments and the mounted composer',
  })
  const marked = '[...CSS.highlights.entries()].filter(([name]) => name.startsWith(document.querySelector(".hydra-chat .messages").dataset.highlight + "-quote-")).flatMap(([, ranges]) => [...ranges].map(range => range.toString()))'
  await check({
    condition: `${marked}.sort().join("|") === "readable|readable paragraph" && [...document.querySelectorAll(".hydra-chat .comment-card .comment-quote mark")].map(m => m.textContent).join("|") === "readable paragraph|readable"`,
    label: 'each comment\'s passage stays highlighted in the reply and its card',
  })
  await check({
    condition: '(() => { const prefix = document.querySelector(\'.hydra-chat .messages\').dataset.highlight + \'-quote-\'; const entries = [...CSS.highlights.entries()].filter(([name]) => name.startsWith(prefix)); return entries.length === 2 && entries.every(([, ranges]) => ranges.size === 1) && document.querySelectorAll(\'.hydra-chat .comment-marker\').length === 2 && [...document.querySelectorAll(\'.hydra-chat .comment-card\')].map(card => card.dataset.commentNumber).join() === \'1,2\'; })()',
    label: 'nested comments paint separate tint layers and share card and passage numbers',
  })
  const cards = 'document.querySelectorAll(".hydra-chat .comment-card").length'
  const host = 'document.querySelector(".hydra-chat [data-caret-host]")'
  const paragraph = '[...document.querySelectorAll(".hydra-chat .message-block p")].find(p => p.textContent.startsWith("A readable paragraph"))'
  await select({
    start: 2,
    end: 20,
  }); await click({ selector: pill })
  await check({
    condition: `${cards} === 2 && document.activeElement.value === "Explain this phrase."`,
    label: 'the same passage selected again reopens its comment',
  })
  await select({
    start: 11,
    end: 19,
  }); await click({ selector: pill })
  await evaluate({ code: 'window.input.focus(); return true;' })
  await check({
    condition: `${cards} === 2`,
    label: 'an empty comment goes when left',
  })
  await select({
    start: 11,
    end: 19,
  }); await click({ selector: pill })
  await evaluate({ code: 'Object.defineProperty(document, "hasFocus", { value: () => false, configurable: true }); document.activeElement.blur(); delete document.hasFocus; return true;' })
  await check({
    condition: `${cards} === 3`,
    label: 'an empty comment stays when the window loses focus',
  })
  await evaluate({ code: 'document.querySelectorAll(".hydra-chat .comment-card textarea")[2].focus(); return true;' })
  await press({ key: 'Escape' })
  await check({
    condition: `${cards} === 2 && document.activeElement === ${host} && getSelection().focusNode === ${paragraph}.lastChild && getSelection().focusOffset === getSelection().focusNode.length`,
    label: 'Escape puts the caret just before the comment cards',
  })
  await press({ key: 'ArrowDown' })
  await check({
    condition: 'document.activeElement.value === "Explain this phrase." && document.activeElement.selectionStart === 0',
    label: 'ArrowDown steps from the text into the next comment',
  })
  await press({ key: 'ArrowDown' })
  await check({
    condition: 'document.activeElement.value === "What does readable mean?"',
    label: 'ArrowDown on a note\'s last line steps into the next comment',
  })
  await press({ key: 'ArrowUp' }); await press({ key: 'ArrowUp' })
  await check({
    condition: `document.activeElement === ${host} && ${paragraph}.contains(getSelection().focusNode)`,
    label: 'ArrowUp on a note\'s first line steps back into the text',
  })
  await evaluate({ code: `window.original = ${paragraph}.textContent; return true;` })
  await select({
    start: 21,
    end: 25,
  })
  await evaluate({ code: `const data = new DataTransfer(); data.setData("text/plain", "Pasted note"); window.pasted = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }); ${paragraph}.dispatchEvent(window.pasted); return true;` })
  await check({
    condition: `${cards} === 3 && document.activeElement.value === "Pasted note" && window.pasted.defaultPrevented`,
    label: 'paste over a selection becomes a comment',
  })
  await evaluate({ code: `${host}.focus(); const data = new DataTransfer(); data.setData("text/plain", "Lost"); window.pasted = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }); ${paragraph}.dispatchEvent(window.pasted); return true;` })
  await check({
    condition: `${cards} === 3 && window.pasted.defaultPrevented && ${paragraph}.textContent === window.original`,
    label: 'paste never edits the output',
  })
  await select({
    start: 2,
    end: 20,
  })
  await evaluate({ code: `const data = new DataTransfer(); data.setData("text/plain", "And why?"); ${paragraph}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); return true;` })
  await check({
    condition: `${cards} === 3 && document.activeElement.value === "Explain this phrase. And why?"`,
    label: 'paste over a commented passage adds to its note',
  })
  await evaluate({ code: `${host}.focus(); return true;` })
  await select({
    start: 2,
    end: 10,
  }); await click({ selector: '.hydra-chat .comment-pill [aria-label="Quote selection"]' })
  await eventually({
    condition: 'window.input.value.includes("> readable") && document.activeElement === window.input',
    label: 'Quote puts the selection in the draft',
  })
  await fill({
    label: 'Reply to Hydra',
    value: '',
  })
  await select({
    start: 11,
    end: 19,
  })
  await evaluate({ code: `${host}.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); return true;` })
  await check({
    condition: `${cards} === 4 && document.activeElement.matches(".hydra-chat .comment-card textarea") && document.activeElement.value === ""`,
    label: 'a composition over a selection opens a comment to land in',
  })
  await evaluate({ code: `${host}.focus(); return true;` })
  await check({
    condition: `${cards} === 3`,
    label: 'the composition\'s comment goes if nothing landed',
  })
  await select({
    start: 0,
    end: 1,
  })
  // A slow upload: the empty note must outlive its blur until the image lands.
  await evaluate({ code: 'const send = window.fetch; window.fetch = async (...args) => { await new Promise(resolve => setTimeout(resolve, 3000)); return send(...args); }; return true;' })
  await evaluate({ code: `const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), c => c.charCodeAt(0)); const data = new DataTransfer(); data.items.add(new File([png], "shot.png", { type: "image/png" })); ${paragraph}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); return true;` })
  await evaluate({ code: `${host}.focus(); return true;` })
  await check({
    condition: `${cards} === 4 && !document.querySelector(".hydra-chat .comment-card .comment-images img")`,
    label: 'an empty comment stays while its image uploads',
  })
  await eventually({
    condition: `${cards} === 4 && !!document.querySelector(".hydra-chat .comment-card .comment-images img")`,
    label: 'a pasted image becomes a comment with the image attached',
  })
  await evaluate({ code: `${host}.focus(); return true;` })
  await select({
    start: 13,
    end: 18,
  })
  await evaluate({ code: `${host}.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "Dictated note", bubbles: true, cancelable: true })); return true;` })
  await check({
    condition: `${cards} === 5 && document.activeElement.value === "Dictated note"`,
    label: 'dictation over a selection becomes a comment',
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await eventually({
    condition: `${cards} === 5`,
    label: 'comment drafts survive a reload',
  })
  await click({ selector: '.hydra-chat .composer-comments [aria-label="Show comments"]' })
  await check({
    condition: 'document.querySelectorAll(".comments-dialog[open] .comment-card").length === 5 && [...document.querySelectorAll(".comments-dialog .comment-quote")].some(q => q.textContent.startsWith("A readable paragraph with") && !q.textContent.includes("**") && q.querySelector("mark").textContent === "readable")',
    label: 'the comments list shows each comment with the context the agent receives',
  })
  await evaluate({ code: 'document.querySelector(".comments-dialog textarea").focus(); return true;' })
  await check({
    condition: '(() => { const card = document.activeElement.closest(\'.comment-card\'); const id = card.dataset.commentRef; const host = document.querySelector(\'.hydra-chat .messages\'); return document.querySelectorAll(\'[data-comment-ref="\' + id + \'"][data-emphasis]\').length === 2 && CSS.highlights.get(host.dataset.highlight + \'-emphasis\').size === 1; })()',
    label: 'focusing a listed comment emphasizes both cards and its passage',
  })
  await screenshot({ name: 'comments-dialog.png' })
  await evaluate({ code: 'const el = document.querySelector(".comments-dialog textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "Explain this phrase, please."); el.dispatchEvent(new Event("input", { bubbles: true })); return true;' })
  await check({
    condition: 'document.querySelector(".hydra-chat .messages .comment-card textarea").value === "Explain this phrase, please."',
    label: 'a comment edited in the list changes under its passage',
  })
  await evaluate({ code: '[...document.querySelectorAll(".comments-dialog .comment-card")].find(card => card.querySelector("textarea").value === "What does readable mean?").querySelector("[aria-label=\'Show in chat\']").click(); return true;' })
  await eventually({
    condition: '!document.querySelector(".comments-dialog") && document.activeElement.matches(".hydra-chat .messages .comment-card textarea") && document.activeElement.value === "What does readable mean?"',
    label: 'Show in chat closes the list onto the comment under its passage',
  })
  await eventually({
    condition: '!!document.querySelector(\'.comment-jump\') && document.activeElement.closest(\'.comment-card\').hasAttribute(\'data-jump\') && getComputedStyle(document.querySelector(\'.comment-jump\')).animationIterationCount === \'1\' && getComputedStyle(document.activeElement.closest(\'.comment-card\'), \'::after\').animationIterationCount === \'1\'',
    label: 'showing a comment pulses its passage and card once',
  })
  await screenshot({ name: 'comment-cards.png' })
  await evaluate({ code: 'window.input = document.querySelector(".hydra-chat .composer textarea"); return true;' })
  await fill({
    label: 'Reply to Hydra',
    value: 'Apply these comments.',
  }); await click({ selector: '.hydra-chat .composer-send' })
  await eventually({
    condition: '!document.querySelector(".hydra-chat .comment-card") && document.querySelector(".hydra-chat .composer textarea").value === ""',
    label: 'delivery clears the submitted comments and draft',
  })
  const sent = loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.text ?? ''
  assert.match(
    sent,
    /Internal note.*no reply needed/,
  )
  assert.match(
    sent,
    /## Comments on your reply from 2026-10-15T10:01:00Z/,
  )
  assert.match(
    sent,
    /2\. > readable paragraph/,
  ); assert.match(
    sent,
    /3\. > readable/,
  )
  assert.match(
    sent,
    /Pasted note/,
  ); assert.match(
    sent,
    /\[image: [^\]]+\/attachments\/[^\]]+\.png\]/,
  ); assert.match(
    sent,
    /Dictated note/,
  )
  assert.match(
    sent,
    /Paragraph:/,
  ); assert.match(
    sent,
    /## Message/,
  ); assert.doesNotMatch(
    sent,
    /pnyx-comment|-----/,
  )
  await select({
    start: 2,
    end: 10,
  }); await click({ selector: pill })
  await note({ value: 'A second round.' }); await press({ key: 'Escape' }); await click({ selector: '.hydra-chat .composer-send' })
  await eventually({
    condition: '!document.querySelector(".hydra-chat .comment-card")',
    label: 'second comment delivered',
  })

  for (const [
    start,
    end,
  ] of [
      [
        2,
        10,
      ],
      [
        11,
        19,
      ],
    ]) {
    await select({
      start,
      end,
    }); await click({ selector: pill })
    await note({ value: 'To discard' })
  }

  const removeAll = '.hydra-chat .composer-comments [aria-label^="Remove all"]'
  await click({ selector: removeAll })
  await check({
    condition: 'document.querySelectorAll(".hydra-chat .comment-card").length === 2 && document.querySelector(".hydra-chat .composer-comments").textContent.includes("Remove 2?")',
    label: 'removing every comment asks first',
  })
  await click({ selector: removeAll })
  await check({
    condition: '!document.querySelector(".hydra-chat .comment-card") && !document.querySelector(".hydra-chat .composer-comments")',
    label: 'the composer pill removes every comment',
  })
  await check({
    condition: `${marked}.length === 0`,
    label: 'removing the comments removes their highlights',
  })
  await select({
    start: 2,
    end: 10,
  }); await click({ selector: pill })
  await note({ value: 'A shared comment.' }); await press({ key: 'Escape' })
  await evaluate({ code: `const peer = document.createElement('iframe'); peer.id = 'comments-peer'; peer.style.display = 'none'; peer.src = ${JSON.stringify(server.url)}; document.body.append(peer); return true;` })
  const peer = 'document.querySelector("#comments-peer").contentDocument'
  await eventually({
    condition: `${peer}.querySelectorAll('.hydra-chat .comment-card').length === 1`,
    label: 'another tab restores the saved comment',
  })
  await select({
    start: 11,
    end: 19,
  }); await click({ selector: pill })
  await evaluate({ code: `const el = ${peer}.querySelector('.hydra-chat .comment-card textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Edited in the other tab.'); el.dispatchEvent(new Event('input', { bubbles: true })); return true;` })
  await eventually({
    condition: `${cards} === 2 && document.querySelector('.hydra-chat .comment-card textarea').value === 'Edited in the other tab.'`,
    label: 'remote edits preserve an actively edited empty note',
  })
  await note({ value: 'A second local comment.' })
  await eventually({
    condition: `${peer}.querySelectorAll('.hydra-chat .comment-card').length === 2 && [...${peer}.querySelectorAll('.hydra-chat .comment-card textarea')].map(n => n.value).join('|') === 'Edited in the other tab.|A second local comment.'`,
    label: 'the next local edit retains the remote change',
  })
  await evaluate({ code: `${peer}.querySelector('.hydra-chat .comment-card [aria-label="Remove comment"]').click(); return true;` })
  await eventually({
    condition: `${cards} === 1 && document.querySelector('.hydra-chat .comment-card textarea').value === 'A second local comment.'`,
    label: 'remote removal updates the remaining local comment',
  })
  await evaluate({ code: 'document.querySelector("#comments-peer").remove(); return true;' })
  await click({ selector: '.hydra-chat .composer-comments [aria-label="Show comments"]' })
  await evaluate({ code: 'document.querySelector(".comments-dialog [aria-label=Close]").focus(); return true;' })
  await press({ key: '/' })
  await check({
    condition: '!!document.querySelector(".comments-dialog[open]") && document.activeElement.matches(".comments-dialog [aria-label=Close]")',
    label: 'comment dialog keys do not navigate the page underneath',
  })
  await evaluate({ code: 'const el = document.querySelector(".comments-dialog textarea"); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); return true;' })
  await press({ key: 'Escape' })
  await eventually({
    condition: `!document.querySelector('.comments-dialog') && ${cards} === 0 && ${marked}.length === 0 && !document.querySelector('.hydra-chat .composer-comments')`,
    label: 'leaving a cleared dialog note removes its card and highlight',
  })
  const blockedStorage = createServer(async (
    req,
    res,
  ) => {
    const response = await fetch(new URL(
      req.url ?? '/',
      server.url,
    ))
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    const body = Buffer.from(await response.arrayBuffer())
    res.writeHead(
      response.status,
      { 'content-type': contentType },
    )
    res.end(contentType.includes('text/html') ? body.toString().replace(
      '<head>',
      `<head><script>
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) {
        if (key.endsWith(':comments')) {
          window.blockedCommentRead = true;
          throw new DOMException('Storage is blocked', 'SecurityError');
        }
        return get.call(this, key);
      };
      new MutationObserver(() => {
        if (window.blockedCommentRead && document.querySelector('.shell')) {
          parent.postMessage('blocked-storage-ready', ${JSON.stringify(new URL(server.url).origin)});
        }
      }).observe(document, { childList: true, subtree: true });
    </script>`,
    ) : body)
  })
  await new Promise<void>(resolve => blockedStorage.listen(
    0,
    '127.0.0.1',
    resolve,
  ))

  try {
    const address = blockedStorage.address()
    assert.ok(address && typeof address === 'object')
    await evaluate({ code: `window.addEventListener('message', event => { if (event.origin === 'http://127.0.0.1:${address.port}' && event.data === 'blocked-storage-ready') window.blockedStorageReady = true; }); const frame = document.createElement('iframe'); frame.id = 'blocked-storage'; frame.style.display = 'none'; frame.src = 'http://127.0.0.1:${address.port}/'; document.body.append(frame); return true;` })
    await eventually({
      condition: 'window.blockedStorageReady === true',
      label: 'blocked comment storage does not prevent the Hydra from rendering',
    })
    await evaluate({ code: 'document.querySelector("#blocked-storage").remove(); return true;' })
  } finally {
    await blockedStorage[Symbol.asyncDispose]()
  }

  assert.equal(
    (loadHydra({ hydraId: 'default' }).state.hydraMessages?.filter(message => message.actor === 'web').map(message => message.text)
      .join('\n')
      .match(/Internal note/g) ?? []).length,
    1,
  )

  await evaluate({ code: advancedSetup })
  await evaluate({
    code: String.raw`
  const t=window.commentTest,p=t.source({prefix:'Repeat'}),text=p.textContent
  await t.make({
    prefix:'Cross block ending',
    from:12,
    to:18,
    text:'late-note',
  })
  const first=text.indexOf('target'),second=text.indexOf(
    'target',
    first+1,
  )
  await t.make({
    prefix:'Repeat',
    from:second,
    to:second+6,
    text:'second-target',
  })
  await t.make({
    prefix:'Repeat',
    from:first,
    to:first+6,
    text:'first-target',
  })
  await t.make({
    prefix:'Repeat',
    from:first,
    to:second+6,
    text:'broad',
  })
  const a=t.ranges({text:'first-target'})[0],b=t.ranges({text:'second-target'})[0]

  if(a.startContainer!==p.firstChild || a.startOffset!==first || b.startContainer!==p.querySelector('strong').firstChild || b.startOffset!==0){
    throw new Error('Repeated occurrence anchors confused')
  }

  const saved=JSON.parse(localStorage.getItem('pnyx:default:comments'))['$hydra']

  if(new Set(saved.filter(c=>c.quote==='target').map(c=>c.start)).size!==2){
    throw new Error('Repeated occurrence storage confused')
  }

  const order=t.cards().map(c=>c.querySelector('textarea').value)
    .join()

  if(order!=='first-target,broad,second-target,late-note'){
    throw new Error('Creation order replaced reading order')
  }

  for(const c of t.cards()){
    if(t.h().querySelector('[data-comment-marker="'+c.dataset.commentId+'"]').textContent!==c.dataset.commentNumber){
      throw new Error('Marker number mismatch')
    }
  }

  return true
`,
  })
  await click({ selector: '.hydra-chat .composer-comments [aria-label="Show comments"]' })
  await check({
    condition: '(() => { const d=document.querySelector(\'.comments-dialog\');return document.getElementById(d.getAttribute(\'aria-labelledby\')).textContent===\'Comments · 4\' && [...d.querySelectorAll(\'.comment-card\')].every(c=>window.commentTest.card({text:c.querySelector(\'textarea\').value}).dataset.commentNumber===c.dataset.commentNumber); })()',
    label: 'reverse-created comments share reading-order numbers across markers, cards and named dialog',
  })
  await evaluate({
    code: String.raw`
  const t=window.commentTest,listed=[...document.querySelectorAll('.comments-dialog .comment-card')]
  listed.find(c=>c.querySelector('textarea').value==='second-target').querySelector('textarea')
    .focus();await t.tick()
  const chosen=t.card({text:'second-target'}),range=t.emphasis()[0]

  if(range.startContainer!==t.source({prefix:'Repeat'}).querySelector('strong').firstChild || document.querySelectorAll('[data-emphasis]').length!==2 || !chosen.hasAttribute('data-emphasis')){
    throw new Error('List focus emphasized wrong passage')
  }

  listed.find(c=>c.querySelector('textarea').value==='first-target').click();await t.tick()

  if(t.emphasis()[0].startContainer!==t.source({prefix:'Repeat'}).firstChild || !t.card({text:'first-target'}).hasAttribute('data-emphasis') || chosen.hasAttribute('data-emphasis')){
    throw new Error('Card body click emphasized wrong passage')
  }

  return true
`,
  })
  await click({ selector: '.comments-dialog [aria-label="Close"]' })
  await evaluate({ code: 'window.commentTest.source({prefix:\'Repeat\'}).scrollIntoView({block:\'center\'});return true;' })
  await hover({ label: 'Go to comment 3' })
  await eventually({
    condition: '(() => { const p=[...document.querySelectorAll(\'.comment-pile\')].find(p=>p.querySelectorAll(\'button\').length===2);const b=[...p.querySelectorAll(\'button\')].map(b=>b.getBoundingClientRect());return p.hasAttribute(\'data-spread\') && b[0].right<=b[1].left; })()',
    label: 'hover spreads neighboring passage markers into separate hit targets',
  })
  await hover({ label: 'Go to comment 3' })
  await check({
    condition: 'window.commentTest.emphasis()[0].startContainer===window.commentTest.source({prefix:\'Repeat\'}).querySelector(\'strong\').firstChild && window.commentTest.card({text:\'second-target\'}).hasAttribute(\'data-emphasis\')',
    label: 'hover identifies the exact repeated passage and linked card',
  })
  await hover({ label: 'Reply to Hydra' })
  await evaluate({ code: 'const t=window.commentTest;t.card({text:\'first-target\'}).querySelector(\'textarea\').focus();t.h().querySelector(\'[aria-label="Go to comment 3"]\').dispatchEvent(new PointerEvent(\'pointerover\',{bubbles:true}));await t.tick();if(t.emphasis()[0].startContainer!==t.source({prefix:\'Repeat\'}).querySelector(\'strong\').firstChild)throw new Error(\'Hover did not override focus\');t.h().querySelector(\'[aria-label="Go to comment 3"]\').dispatchEvent(new PointerEvent(\'pointerout\',{bubbles:true,relatedTarget:document.body}));await t.tick();if(t.emphasis()[0].startContainer!==t.source({prefix:\'Repeat\'}).firstChild)throw new Error(\'Focus did not return after hover\');return true;' })
  await evaluate({ code: 'document.querySelector(\'[aria-label="Go to comment 2"]\').focus();return true;' })
  await check({
    condition: 'document.activeElement.closest(\'.comment-pile\').hasAttribute(\'data-spread\')',
    label: 'keyboard focus opens the pile',
  })
  await evaluate({ code: 'document.querySelector(\'[aria-label="Go to comment 3"]\').focus();return true;' })
  await check({
    condition: 'document.activeElement.closest(\'.comment-pile\').hasAttribute(\'data-spread\')',
    label: 'moving focus within a pile keeps its markers available',
  })
  await press({ key: 'Enter' })
  await eventually({
    condition: 'document.activeElement===window.commentTest.card({text:\'second-target\'}).querySelector(\'textarea\')',
    label: 'keyboard activation focuses the matching comment',
  })
  await evaluate({ code: 'document.querySelector(\'[aria-label="Go to comment 2"]\').click();return true;' })
  await eventually({
    condition: 'document.activeElement===window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\')',
    label: 'pointer activation focuses a different stacked comment',
  })
  await evaluate({ code: 'document.querySelector(\'.hydra-chat .composer textarea\').focus();return true;' })
  await eventually({
    condition: '![...document.querySelectorAll(\'.comment-pile\')].some(p=>p.hasAttribute(\'data-spread\')) && !document.querySelector(\'.comment-card[data-emphasis]\') && window.commentTest.emphasis().length===0',
    label: 'leaving markers and cards closes piles and clears live emphasis',
  })
  await evaluate({ code: 'window.commentTest.card({text:\'first-target\'}).querySelector(\'[aria-label="Remove comment"]\').click();return true;' })
  await check({
    condition: 'window.commentTest.cards().map(c=>c.dataset.commentNumber+\':\'+c.querySelector(\'textarea\').value).join()===\'1:broad,2:second-target,3:late-note\' && window.commentTest.cards().every(c=>window.commentTest.h().querySelector(\'[data-comment-marker="\'+c.dataset.commentId+\'"]\').textContent===c.dataset.commentNumber)',
    label: 'removal renumbers surviving cards and markers consistently',
  })
  await evaluate({
    code: String.raw`
  const t=window.commentTest
  await t.make({
    prefix:'Image caption',
    from:6,
    to:13,
    text:'caption-note',
  })
  const context=t.card({text:'caption-note'}).querySelector('.comment-quote')
  // The full context shows in the shared tooltip above the card.
  const tooltip=async ({card})=>{
    const anchor=card.querySelector('.comment-quote').closest('.tooltip-anchor')
    anchor.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))
    await new Promise(resolve=>setTimeout(resolve,50))
    const text=anchor.querySelector('.tooltip')?.textContent
    anchor.dispatchEvent(new PointerEvent('pointerout',{bubbles:true}))
    await t.tick()

    return text
  }

  if(await tooltip({card:t.card({text:'caption-note'})})!==t.source({prefix:'Image caption'}).textContent || !context.textContent.includes('linked alt') || !context.textContent.includes('<em>markup</em>')){
    throw new Error('Card context differs from rendered Markdown')
  }

  const beginning=t.source({prefix:'Cross block beginning'}),ending=t.source({prefix:'Cross block ending'})
  await t.make({
    prefix:'Cross block beginning',
    from:beginning.textContent.indexOf('words.'),
    endPrefix:'Cross block ending',
    to:5,
    text:'short-cross',
  })

  if(await tooltip({card:t.card({text:'short-cross'})})!==beginning.textContent+'\n\n'+ending.textContent){
    throw new Error('Short cross-block context lost a paragraph')
  }

  t.card({text:'short-cross'}).querySelector('[aria-label="Remove comment"]')
    .click()
  await t.tick()
  await t.make({
    prefix:'Cross block beginning',
    from:6,
    endPrefix:'Cross block ending',
    to:18,
    text:'cross-block',
  })
  const ranges=t.ranges({text:'cross-block'}),text=ranges.map(r=>r.toString()).join('')

  if(!ranges.some(r=>r.startContainer.parentElement.closest('p')===t.source({prefix:'Cross block beginning'})) || !ranges.some(r=>r.startContainer.parentElement.closest('p')===t.source({prefix:'Cross block ending'})) || text!=='block beginning with selected words.Cross block ending'){
    throw new Error('Cross-block range lost source text or included cards')
  }

  return true
`,
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await eventually({
    condition: 'document.querySelectorAll(\'.hydra-chat .comment-card\').length===5',
    label: 'cross-block and repeated-occurrence anchors survive reload',
  })
  await evaluate({ code: advancedSetup })
  await check({
    condition: 'window.commentTest.ranges({text:\'cross-block\'}).map(r=>r.toString()).join(\'\')===\'block beginning with selected words.Cross block ending\' && window.commentTest.ranges({text:\'second-target\'})[0].startContainer===window.commentTest.source({prefix:\'Repeat\'}).querySelector(\'strong\').firstChild',
    label: 'reload paints complete cross-block selection and the selected repeated occurrence',
  })
  await evaluate({
    code: String.raw`
  const t=window.commentTest,n=t.card({text:'broad'}).querySelector('textarea')
  window.beforeNavigation=t.source({prefix:'Repeat'}).textContent
  window.originalNote=n.value
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  ).set.call(
    n,
    'First line\n'+'wrapping words '.repeat(20)+'\nLast line end.',
  )
  n.dispatchEvent(new Event(
    'input',
    {bubbles:true},
  ));await t.tick()
  n.style.flex='none';n.style.width='180px';n.focus();const middle=Math.floor(n.value.length/2);n.setSelectionRange(
    middle,
    middle,
  );window.noteBefore=n.selectionStart

  return true
`,
  })
  await press({ key: 'ArrowUp' })
  await check({
    condition: 'document.activeElement===window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\') && document.activeElement.selectionStart!==window.noteBefore',
    label: 'Up on an interior soft-wrapped line stays in the note and moves normally',
  })
  await press({ key: 'ArrowDown' })
  await check({
    condition: 'document.activeElement===window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\')',
    label: 'Down on an interior wrapped line stays in the note',
  })
  await evaluate({ code: 'const n=window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\');n.setSelectionRange(1,3);return true;' })
  await press({ key: 'ArrowUp' })
  await check({
    condition: 'document.activeElement===window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\')',
    label: 'a noncollapsed note selection does not leave on Up',
  })
  await evaluate({ code: 'document.activeElement.setSelectionRange(3,3);return true;' })
  await press({ key: 'Shift+ArrowUp' })
  await check({
    condition: 'document.activeElement===window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\')',
    label: 'Shift+Up extends a note selection without leaving',
  })
  await evaluate({ code: 'document.activeElement.setSelectionRange(3,3);return true;' })
  await press({ key: 'ArrowUp' })
  await check({
    condition: 'document.activeElement===window.commentTest.h()',
    label: 'Up from a nonzero offset on the first visual line returns to source',
  })
  await evaluate({ code: 'const n=window.commentTest.card({text:\'broad\'}).querySelector(\'textarea\');n.focus();n.setSelectionRange(n.value.length-4,n.value.length-4);return true;' })
  await press({ key: 'ArrowDown' })
  await check({
    condition: 'document.activeElement===window.commentTest.card({text:\'second-target\'}).querySelector(\'textarea\') && window.commentTest.source({prefix:\'Repeat\'}).textContent===window.beforeNavigation',
    label: 'Down from the last visual line enters the next note without changing source',
  })
  await evaluate({ code: 'const t=window.commentTest,n=t.card({text:\'broad\'}).querySelector(\'textarea\');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,\'value\').set.call(n,window.originalNote);n.dispatchEvent(new Event(\'input\',{bubbles:true}));n.style.removeProperty(\'width\');n.style.removeProperty(\'flex\');return true;' })
  await eventually({
    condition: '!document.querySelector(\'.comment-jump\')',
    label: 'previous navigation pulse finishes',
  })
  await evaluate({
    code: String.raw`
  const t=window.commentTest,h=t.h(),s=h.closest('.thread')
  window.motion={
    arrived:false,
    pulses:[],
    requests:[],
  }
  const scroll=s.scrollTo.bind(s)

  s.scrollTo=options=>{
    window.motion.requests.push(options.behavior);scroll(options)
  }

  s.addEventListener(
    'scrollend',
    ()=>window.motion.arrived=true,
  )
  const seen=new WeakSet()
  new MutationObserver(()=>{
    const jump=h.querySelector('.comment-jump'),c=h.querySelector('.comment-card[data-jump]')

    if(!jump||!c||seen.has(jump)){
      return
    }

    seen.add(jump);const r=t.ranges({text:c.querySelector('textarea').value})[0].getBoundingClientRect(),v=s.getBoundingClientRect();window.motion.pulses.push({
      id:c.dataset.commentId,
      arrived:window.motion.arrived,
      visible:r.top>=v.top&&r.bottom<=v.bottom,
      running:jump.getAnimations().some(a=>a.playState==='running'),
    })
  }).observe(
    h,
    {
      childList:true,
      attributes:true,
      subtree:true,
    },
  )
  s.scrollTo({
    top:0,
    behavior:'instant',
  });await t.tick();await t.tick();window.motion={
    arrived:false,
    pulses:[],
    requests:[],
  }
  document.querySelector('.composer-comments [aria-label="Show comments"]').click()

  return true
`,
  })
  await evaluate({ code: 'const t=window.commentTest;[...document.querySelectorAll(\'.comments-dialog .comment-card\')].find(c=>c.querySelector(\'textarea\').value===\'broad\').querySelector(\'[aria-label="Show in chat"]\').click();return true;' })
  await eventually({
    condition: 'window.motion.pulses.length===1',
    label: 'offscreen list jump produces one arrival pulse',
  })
  await check({
    condition: 'window.motion.requests.includes(\'smooth\') && window.motion.pulses[0].arrived && window.motion.pulses[0].visible && window.motion.pulses[0].running && window.motion.pulses[0].id===window.commentTest.card({text:\'broad\'}).dataset.commentId',
    label: 'list jump reaches its exact quote before a running passage/card pulse',
  })
  await eventually({
    condition: '!document.querySelector(\'.comment-jump\') && !document.querySelector(\'.comment-card[data-jump]\')',
    label: 'arrival pulse settles and clears both targets',
  })
  await evaluate({ code: 'const t=window.commentTest,s=t.h().closest(\'.thread\');t.card({text:\'broad\'}).querySelector(\'textarea\').focus({preventScroll:true});s.scrollTo({top:s.scrollHeight,behavior:\'instant\'});await t.tick();await t.tick();window.motion={arrived:false,pulses:[],requests:[]};return true;' })
  await press({ key: 'Escape' })
  await eventually({
    condition: 'window.motion.pulses.length===1',
    label: 'Escape from a saved note pulses after returning to its quote',
  })
  await check({
    condition: 'window.motion.requests.includes(\'smooth\') && window.motion.pulses[0].arrived && window.motion.pulses[0].visible && document.activeElement===window.commentTest.h()',
    label: 'Escape scrolls above to the source before pulsing and preserves its caret',
  })
  await eventually({
    condition: '!document.querySelector(\'.comment-jump\')',
    label: 'Escape pulse clears',
  })
  await evaluate({ code: 'window.motion={arrived:true,pulses:[],requests:[]};window.commentTest.h().querySelector(\'[aria-label="Go to comment 1"]\').click();return true;' })
  await eventually({
    condition: 'window.motion.pulses.length===1',
    label: 'a repeated jump creates one fresh pulse',
  })
  await eventually({
    condition: '!document.querySelector(\'.comment-jump\')',
    label: 'repeated jump clears',
  })
  await evaluate({
    code: String.raw`
  const t=window.commentTest,s=t.h().closest('.thread');s.scrollTo({
    top:0,
    behavior:'instant',
  });await t.tick();await t.tick();window.motion={
    arrived:false,
    pulses:[],
    requests:[],
  }
  const arrived=new Promise(resolve=>s.addEventListener(
    'scrollend',
    resolve,
    {once:true},
  ))
  t.h().querySelector('[aria-label="Go to comment 1"]')
    .click();s.dispatchEvent(new WheelEvent(
    'wheel',
    {bubbles:true},
  ));await arrived;await t.tick()

  if(window.motion.pulses.length){
    throw new Error('Interrupted jump pulsed')
  }

  s.scrollTo({
    top:0,
    behavior:'instant',
  });await t.tick();await t.tick();window.motion={
    arrived:false,
    pulses:[],
    requests:[],
  }
  t.h().querySelector('[aria-label="Go to comment 1"]')
    .click();t.h().querySelector('[data-comment-marker="'+t.card({text:'late-note'}).dataset.commentId+'"]')
    .click()

  return true
`,
  })
  await eventually({
    condition: 'window.motion.pulses.length===1',
    label: 'a superseding jump has one arrival pulse',
  })
  await check({
    condition: 'window.motion.pulses[0].id===window.commentTest.card({text:\'late-note\'}).dataset.commentId',
    label: 'a superseded jump never pulses the old comment',
  })
  await eventually({
    condition: '!document.querySelector(\'.comment-jump\')',
    label: 'superseding pulse clears',
  })

  await evaluate({ code: 'document.querySelector(\'.hydra-chat .composer textarea\').focus();return true;' })
  await eventually({
    condition: '![...CSS.highlights.keys()].some(k=>k.includes(\'-fade-\'))',
    label: 'older paint exits finish before fade lifecycle check',
  })
  await evaluate({
    code: String.raw`
  const t=window.commentTest,prefix=t.h().dataset.highlight,duration=parseFloat(getComputedStyle(t.h()).getPropertyValue('--comment-fade-duration'))
  const raf=requestAnimationFrame.bind(window),cancel=cancelAnimationFrame.bind(window),descriptor=Object.getOwnPropertyDescriptor(
    performance,
    'now',
  )
  const callbacks=new Map();let next=1000000,now=performance.now()
  const original=()=>new Promise(raf)

  window.requestAnimationFrame=callback=>{
    callbacks.set(
      ++next,
      callback,
    )

    return next
  }

  window.cancelAnimationFrame=id=>{
    callbacks.delete(id)
  }

  Object.defineProperty(
    performance,
    'now',
    {
      configurable:true,
      value:()=>now,
    },
  )

  const step=async ({delta})=>{
    now+=delta;const batch=[...callbacks.values()];callbacks.clear();batch.forEach(callback=>callback(now));await original()
  }

  const fading=()=>[...CSS.highlights.entries()].filter(([name])=>name.startsWith(prefix+'-fade-'))

  try {
    const before=t.ranges({text:'broad'});t.card({text:'broad'}).querySelector('[aria-label="Remove comment"]')
      .click();await original()
    const removed=fading().find(([name])=>!name.includes('emphasis'))

    if(!removed || [...removed[1]].map(r=>r.toString()).join('')!==before.map(r=>r.toString()).join('')){
      throw new Error('Removed tint was not retained for fading')
    }

    const style=document.getElementById(removed[0]),initial=style.sheet.cssRules[0].style.backgroundColor

    if(Number(initial.match(/ ([0-9.]+)%/)[1])!==parseFloat(getComputedStyle(t.h()).getPropertyValue('--comment-highlight-strength'))){
      throw new Error('Fade starts with a different tint')
    }

    await step({delta:duration/2})

    if(!document.getElementById(removed[0]) || style.sheet.cssRules[0].style.backgroundColor===initial){
      throw new Error('Removed tint did not weaken')
    }

    if(t.ranges({text:'second-target'})[0].startContainer!==t.source({prefix:'Repeat'}).querySelector('strong').firstChild){
      throw new Error('Index shift faded the survivor')
    }

    await step({delta:duration/2+1})

    if(fading().length){
      throw new Error('Removed tint leaked')
    }

    const marker=t.h().querySelector('[data-comment-marker="'+t.card({text:'second-target'}).dataset.commentId+'"]'),card=t.card({text:'second-target'})
    marker.dispatchEvent(new PointerEvent(
      'pointerover',
      {bubbles:true},
    ));await original();getComputedStyle(card).backgroundColor
    marker.dispatchEvent(new PointerEvent(
      'pointerout',
      {
        bubbles:true,
        relatedTarget:document.body,
      },
    ));await original()
    const emphasis=fading().find(([name])=>name.includes('emphasis'))

    if(!emphasis || [...emphasis[1]][0].startContainer!==t.source({prefix:'Repeat'}).querySelector('strong').firstChild){
      throw new Error('Cleared emphasis did not retain its own passage')
    }

    if(parseFloat(getComputedStyle(card).transitionDuration)<=0){
      throw new Error('Card emphasis does not fade')
    }

    const emphasisStyle=document.getElementById(emphasis[0]),strong=emphasisStyle.sheet.cssRules[0].style.backgroundColor

    if(Number(strong.match(/ ([0-9.]+)%/)[1])!==parseFloat(getComputedStyle(t.h()).getPropertyValue('--comment-emphasis-strength'))){
      throw new Error('Fade starts with different emphasis')
    }

    await step({delta:duration/2})

    if(emphasisStyle.sheet.cssRules[0].style.backgroundColor===strong){
      throw new Error('Emphasis tint did not weaken')
    }

    await step({delta:duration/2+1})

    if(fading().length){
      throw new Error('Emphasis leaked')
    }

    marker.dispatchEvent(new PointerEvent(
      'pointerover',
      {bubbles:true},
    ));await original()
    marker.dispatchEvent(new PointerEvent(
      'pointerout',
      {
        bubbles:true,
        relatedTarget:document.body,
      },
    ));await original();
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Settings').click();await original()

    if([...CSS.highlights.keys()].some(name=>name.startsWith(prefix+'-')) || [...document.querySelectorAll('style[id]')].some(style=>style.id.startsWith(prefix+'-'))){
      throw new Error('Unmount leaked transient paint')
    }
  } finally {
    window.requestAnimationFrame=raf;window.cancelAnimationFrame=cancel

    if(descriptor){
      Object.defineProperty(
        performance,
        'now',
        descriptor,
      )
    }else {
      delete performance.now
    }

    callbacks.clear()
  }

  return true
`,
  })
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await eventually({
    condition: '!!document.querySelector(\'.settings\') && document.querySelector(\'.app\')?.dataset.connected===\'true\'',
    label: 'reload restores the saved Settings page',
  })
  await click({ selector: '.hydra-name[data-hydra-current]' })
  await eventually({
    condition: 'document.querySelectorAll(\'.hydra-chat .comment-card\').length===4',
    label: 'surviving drafts reopen after fade and unmount',
  })
  await evaluate({ code: advancedSetup })
  await click({ selector: '.hydra-chat .composer-comments [aria-label="Show comments"]' })
  await check({
    condition: '[...document.querySelectorAll(\'.comments-dialog .comment-card\')].every(c=>window.commentTest.card({text:c.querySelector(\'textarea\').value}).dataset.commentNumber===c.dataset.commentNumber)',
    label: 'listed numbers follow deletions and cross-block additions',
  })
  await click({ selector: '.comments-dialog [aria-label="Close"]' })
  await fill({
    label: 'Reply to Hydra',
    value: 'Apply interaction review.',
  })
  await click({ selector: '.hydra-chat .composer-send' })
  await eventually({
    condition: '!document.querySelector(\'.hydra-chat .comment-card\')',
    label: 'interaction comments are delivered together',
  })
  const interactionReply = loadHydra({ hydraId: 'default' }).state.hydraMessages?.filter(message => message.actor === 'web').at(-1)?.text ?? ''
  assert.ok(interactionReply.includes('1. > target\n\nParagraph:\n\n> Repeat target before **target** after target.\n\nsecond-target'))
  assert.ok(interactionReply.includes('2. > caption') && interactionReply.includes('3. > block beginning with selected words.\n> \n> Cross block ending\n\ncross-block') && interactionReply.includes('4. > ending'))
  const reduced = smokeBrowser({
    home,
    session: 'pnyx-chat-reduced',
    reducedMotion: true,
  })

  try {
    await reduced.browser({
      args: [
        'open',
        server.url,
      ],
    })
    await reduced.eventually({
      condition: '!![...document.querySelectorAll(\'.hydra-chat .message-block p\')].find(p=>p.textContent.startsWith(\'Repeat\'))',
      label: 'reduced-motion conversation ready',
    })
    await reduced.evaluate({ code: advancedSetup })
    await reduced.evaluate({
      code: String.raw`
  const t=window.commentTest

  if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
    throw new Error('Reduced motion flag inactive')
  }

  await t.make({
    prefix:'Repeat',
    from:7,
    to:13,
    text:'reduced-note',
  })
  const h=t.h(),s=h.closest('.thread'),c=t.card({text:'reduced-note'}),marker=h.querySelector('.comment-marker')
  s.scrollTo({
    top:0,
    behavior:'instant',
  });await t.tick();await t.tick();marker.click();await t.tick()
  const r=t.ranges({text:'reduced-note'})[0].getBoundingClientRect(),v=s.getBoundingClientRect(),top=s.scrollTop

  if(r.top<v.top || r.bottom>v.bottom || !h.querySelector('.comment-jump') || h.querySelector('.comment-jump').getAnimations().length || c.getAnimations().some(a=>a.playState==='running')){
    throw new Error('Reduced jump moved or animated')
  }

  await t.tick()

  if(top!==s.scrollTop){
    throw new Error('Reduced scroll did not settle instantly')
  }

  h.focus({preventScroll:true});await t.tick()
  marker.dispatchEvent(new PointerEvent(
    'pointerover',
    {bubbles:true},
  ));await t.tick();marker.dispatchEvent(new PointerEvent(
    'pointerout',
    {
      bubbles:true,
      relatedTarget:document.body,
    },
  ));await t.tick()
  c.querySelector('[aria-label="Remove comment"]').click();await t.tick()

  if([...CSS.highlights.keys()].some(name=>name.includes('-fade-')) || !getComputedStyle(h.querySelector('.comment-annotations')).display){
    throw new Error('Reduced removal faded')
  }

  if(document.querySelector('style[id*="-fade-"]')){
    throw new Error('Reduced removal kept transient styles')
  }

  return true
`,
    })
  } finally {
    await reduced.close()
  }

  await screenshot({ name: 'chat.png' })
  const consoleOutput = await browser({ args: ['console'] }); assert.doesNotMatch(
    consoleOutput,
    /TypeError|ReferenceError|Uncaught/,
  )
  process.stdout.write('Conversation browser smoke passed.\n')
} finally {
  await server.close(); await close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
