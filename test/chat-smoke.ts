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

process.env.PNYX_SEMANTIC = 'off'
const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-chat-smoke-',
))
process.env.PNYX_HOME = home
const fixture = seedWebFixture({ home })
const markdown = readFileSync(
  join(
    import.meta.dirname,
    'fixtures/web/chat.md',
  ),
  'utf8',
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
  const marked = '[...CSS.highlights.get(document.querySelector(".hydra-chat .messages").dataset.highlight)].map(range => range.toString())'
  await check({
    condition: `${marked}.sort().join("|") === "readable|readable paragraph" && [...document.querySelectorAll(".hydra-chat .comment-card .comment-quote mark")].map(m => m.textContent).join("|") === "readable paragraph|readable"`,
    label: 'each comment\'s passage stays highlighted in the reply and its card',
  })
  await check({
    condition: '(() => { const name = document.querySelector(\'.hydra-chat .messages\').dataset.highlight; return CSS.highlights.get(name + \'-0\').size === 1 && CSS.highlights.get(name + \'-1\').size === 1 && document.querySelectorAll(\'.hydra-chat .comment-marker\').length === 2 && [...document.querySelectorAll(\'.hydra-chat .comment-card\')].map(card => card.dataset.commentNumber).join() === \'1,2\'; })()',
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
  await check({
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
