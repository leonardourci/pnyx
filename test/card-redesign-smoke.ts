import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import { decidePush, decideReply } from '../src/core/decide.ts'
import { permissionEvent } from '../src/core/permissions.ts'
import { startServer } from '../src/server/server.ts'
import { withWriter } from '../src/store/hydra-store.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { smokeBrowser } from './browser.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-card-redesign-',
))
process.env.PNYX_HOME = home
process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
commands.hydra([
  'create',
  'default',
])
commands.task([
  'create',
  '--key',
  'layout',
  '--title',
  'Choose the conversation layout',
  '--column',
  'in_progress',
])
commands.task([
  'status',
  'layout',
  'needs_you',
  '--note',
  'Updates above chat, or tabs?',
])

for (const [
  index,
  kind,
  url,
] of [
    [
      1,
      'github_pr',
      'https://github.com/example/project/pull/57',
    ],
    [
      2,
      'linear',
      'https://linear.app/example/issue/UI-42',
    ],
    [
      3,
      'url',
      'https://example.com/layout',
    ],
    [
      4,
      'url',
      'https://example.com/notes',
    ],
  ] as const) {
  commands.link([
    'layout',
    '--url',
    url,
    '--kind',
    kind,
    '--title',
    `Conversation layout reference ${index} with a very long title to trim`,
    '--number',
    String(index),
    '--state',
    'open',
  ])
}

withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const card = writer.state.cards[writer.state.keys.layout!]!
    const pushed = decidePush({
      state: writer.state,
      key: card.key,
      input: {
        agent: {
          provider: 'codex',
          sessionId: 'fixture',
          host: 'pnyx',
        },
      },
      meta: {
        actor: 'fixture',
        at: new Date().toISOString(),
      },
    })

    if ('event' in pushed) {
      writer.append({ event: pushed.event })
    }

    writer.append({
      event: permissionEvent({
        state: writer.state,
        card,
        request: {
          id: 'layout-answer',
          session: 'fixture',
          tool: 'AskUserQuestion',
          input: {},
          status: 'allow',
          questions: [
            {
              question: 'Updates above chat, or tabs?',
              options: [{ label: 'Updates above chat' }],
            },
          ],
          answers: [['Updates above chat']],
        },
        meta: {
          actor: 'hydra',
          reason: 'The owner chose this in the design review',
          at: new Date().toISOString(),
        },
      }),
    })
    const notice = hydraEvent({
      state: writer.state,
      cardId: HYDRA_CARD,
      meta: {
        actor:'hydra',
        at:new Date().toISOString(),
      },
      change:{
        type:'hydra.message',
        data:{
          hydra:'hydra',
          action:'worker',
          task:card.id,
          text:`The work on [@old layout title](pnyx-task:${card.id}) is ready for your decision.`,
        },
      },
    })

    if ('event' in notice) {
      writer.append({event: notice.event})
    }
  },
})
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
})
const b = smokeBrowser({
  home,
  session: 'pnyx-card-redesign',
})

try {
  await b.browser({
    args: [
      'open',
      server.url,
    ],
  })
  await b.browser({
    args: [
      'resize',
      '1440',
      '1000',
    ],
  })
  await b.eventually({
    condition: '!!document.querySelector(".card-links")',
    label: 'link chips appear',
  })
  await b.check({
    condition: 'document.querySelectorAll(".card-link").length === 2 && document.querySelector(".card-links button").textContent === "+2"',
    label: 'closed cards limit link chips',
  })

  const checkHoverPill = async ({ state }: { state: string }) => {
    await b.evaluate({ code: 'const card = document.querySelector(".card"); card.closest(".column-cards").scrollTop = 0; card.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true;' })
    await b.check({
      condition: '(() => { const card = document.querySelector(".card"), pill = card.querySelector(".card-menu"), column = card.closest(".column-cards"); const rect = pill.getBoundingClientRect(); return pill.matches(":popover-open") && rect.top < column.getBoundingClientRect().top && pill.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 2)); })()',
      label: `${state} top card hover pill is visible and clickable above the column`,
    })
    const snapshot = await b.browser({
      args: [
        'snapshot',
        '--full',
      ],
    })
    const title = snapshot.match(/uid=(\S+) button "Open task Choose the conversation layout"/)

    if (!title) {
      throw new Error(snapshot)
    }

    await b.browser({
      args: [
        'hover',
        `@${title[1]}`,
      ],
    })
    await b.check({
      condition:'[...document.querySelector(".card-menu").querySelectorAll("button")].map(button=>button.getAttribute("aria-label")).join(",") === "Remind,Edit,Hide"',
      label:`${state} pill has exactly the three supported icon actions`,
    })
    const actions=await b.browser({
      args:[
        'snapshot',
        '--full',
      ],
    })
    const remind=actions.match(/uid=(\S+) button "Remind"/)

    if(!remind){
      throw new Error(actions)
    }

    await b.browser({
      args:[
        'hover',
        `@${remind[1]}`,
      ],
    })
    const hovered=await b.browser({
      args:[
        'snapshot',
        '--full',
      ],
    })
    const target=hovered.match(/uid=(\S+) button "Remind"/)

    if(!target){
      throw new Error(hovered)
    }

    await b.browser({
      args:[
        'click',
        `@${target[1]}`,
      ],
    })
    await b.eventually({
      condition:'!!document.querySelector(".reminder-editor")',
      label:`${state} floating Remind opens its editor`,
    })
    const outside=await b.browser({
      args:[
        'snapshot',
        '--full',
      ],
    })
    const settings=outside.match(/uid=(\S+) button "Settings"/)

    if(!settings){
      throw new Error(outside)
    }

    await b.browser({
      args:[
        'hover',
        `@${settings[1]}`,
      ],
    })
    await b.eventually({
      condition:'!document.querySelector(".card-menu:popover-open") && !document.querySelector(".card").matches(":hover")',
      label:`${state} actions and hover clear after mouse leave even with editor focus`,
    })
    await b.text({label:'Cancel'})
    await b.press({ key: 'Tab' })
    await b.evaluate({code:'document.querySelector(".card").dispatchEvent(new PointerEvent("pointerover",{bubbles:true}));return true'})
    await b.focus({selector:'.card-menu [aria-label=Remind]'})
    await b.press({key:'Tab'})
    await b.check({
      condition:'document.activeElement?.getAttribute("aria-label") === "Edit"',
      label:`${state} action pill supports keyboard navigation`,
    })
    await b.screenshot({ name: `card-redesign-${state}-hover.png` })
    await b.focus({ selector: '.card-open' })
    const resting = await b.browser({
      args: [
        'snapshot',
        '--full',
      ],
    })
    const restingTitle = resting.match(/uid=(\S+) button "Open task Choose the conversation layout"/)

    if (!restingTitle) {
      throw new Error(resting)
    }

    await b.browser({
      args: [
        'hover',
        `@${restingTitle[1]}`,
      ],
    })
  }

  await checkHoverPill({ state: 'closed' })
  await b.click({ selector: '.card-state' })
  await b.eventually({
    condition: '!!document.querySelector(".card.selected")',
    label: 'body opens the card',
  })
  await b.click({ selector: '.card-state' })
  await b.eventually({
    condition: '!document.querySelector(".card.selected")',
    label: 'body closes the card',
  })
  await b.check({
    condition: '!document.querySelector(".card-parent, .detail-header, .detail-footer")',
    label: 'duplicate actions and subtask/footer rows are absent',
  })
  await b.focus({ selector: '.card > .resize-y' })
  await b.press({ key: 'Home' })
  await b.eventually({
    condition: '(() => {const card=document.querySelector(".card"),grip=card.querySelector(".resize-y");return Math.abs(card.getBoundingClientRect().height-Number(grip.getAttribute("aria-valuemin")))<2})()',
    label: 'card shrinks to its content minimum',
  })
  await b.check({
    condition: '(() => {const card=document.querySelector(".card"),answer=card.querySelector(".card-question button"),links=card.querySelector(".card-links");return [answer,links].every(el=>el.getBoundingClientRect().bottom<=card.getBoundingClientRect().bottom)})()',
    label: 'minimum includes the complete question, Answer and links',
  })
  await b.press({ key: 'End' })
  await b.eventually({
    condition: '(() => {const card=document.querySelector(".card"),grip=card.querySelector(".resize-y");return Math.abs(card.getBoundingClientRect().height-Number(grip.getAttribute("aria-valuemax")))<2})()',
    label: 'card stops at its full content maximum',
  })
  await b.screenshot({ name: 'card-redesign-closed.png' })
  await b.evaluate({ code: 'window.cardHeight = document.querySelector(".card").getBoundingClientRect().height; document.querySelector(".card-since").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true;' })
  await b.eventually({
    condition: 'document.querySelector("[role=tooltip]")?.textContent.startsWith("Created ")',
    label: 'time tooltip shows creation date',
  })
  await b.eventually({
    condition: '(() => { const card = document.querySelector(".card"), tip = document.querySelector(".tooltip"); return card.getBoundingClientRect().height === window.cardHeight && getComputedStyle(card.querySelector(".card-menu")).opacity === "0" && tip.getBoundingClientRect().bottom <= card.querySelector(".card-since").getBoundingClientRect().top; })()',
    label: 'tooltip is above its trigger, hides actions, and preserves height',
  })
  await b.evaluate({ code: 'document.querySelector(".card-agent").parentElement.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true;' })
  await b.eventually({
    condition: 'document.querySelector(".tooltip")?.textContent.includes("Codex")',
    label: 'agent icon tooltip names its harness',
  })
  await b.check({
    condition: 'document.querySelectorAll(".tooltip").length === 1',
    label: 'only one tooltip is visible',
  })
  await b.evaluate({ code: 'document.querySelector(".card-agent").parentElement.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })); document.querySelector(".card-link").parentElement.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true;' })
  await b.check({
    condition: '!document.querySelector(".tooltip")',
    label: 'link tooltip waits before appearing',
  })
  await b.eventually({
    condition: 'document.querySelector(".tooltip")?.textContent.includes("https://github.com/example/project/pull/57")',
    label: 'delayed link tooltip shows title and URL',
  })
  await b.screenshot({ name: 'card-redesign-tooltip.png' })
  await b.evaluate({ code: 'document.querySelector(".card-link").parentElement.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })); return true;' })
  await b.click({ selector: '.card-links button' })
  await b.check({
    condition: 'document.querySelectorAll(".card-link").length === 4 && !document.querySelector(".card.selected")',
    label: '+N reveals remaining links without opening the card',
  })
  await b.evaluate({
    code: `
      document.querySelector('.hydra-chat [data-task-ref]').click();
      for (let i = 0; i < 100; i++) {
        const card = document.querySelector('.card.selected');
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (card && (reduced || card.getAnimations().length > 0)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('a task reference opens and highlights its card');
    `,
  })

  await b.eventually({
    condition: '!!document.querySelector(".decision")',
    label: 'answered question appears as a paired decision',
  })
  await checkHoverPill({ state: 'open' })
  await b.check({
    condition:'!document.querySelector(".card-content > .card-question") && !!document.querySelector(".task-updates .pending-question") && !document.querySelector(".card-metadata").open',
    label:'open card folds secondary details and moves its question into Updates',
  })
  await b.check({
    condition:'document.querySelector(".pending-question .update-heading strong").textContent === "Decision needed" && !document.querySelector(".task-updates .card-question") && [...document.querySelectorAll(".task-updates ol > li")].filter(row=>row.textContent.includes("Updates above chat, or tabs?") && !row.querySelector(".decision")).length === 1',
    label:'one integrated Decision needed entry replaces the duplicate status and Question box',
  })
  await b.check({
    condition:'document.querySelector(".task-updates ol").firstElementChild.classList.contains("pending-question")',
    label:'newest first pins the pending question above updates',
  })
  await b.click({selector:'.updates-order'})
  await b.check({
    condition:'document.querySelector(".task-updates ol").lastElementChild.classList.contains("pending-question")',
    label:'oldest first pins the pending question after updates',
  })
  await b.click({selector:'.updates-order'})
  await b.click({selector:'.card-metadata summary'})
  await b.check({
    condition:'document.querySelector(".card-metadata").open && !!document.querySelector(".card-metadata .card-links")',
    label:'Details reveals the labels and links on demand',
  })
  await b.click({selector:'.card-metadata summary'})

  await b.check({
    condition: '(() => { const fold = document.querySelector(".decision"); return !fold.open && fold.textContent.includes("Updates above chat") && fold.textContent.includes("by Hydra") && ![...document.querySelectorAll(".detail button")].some(button => ["Reassign", "Add subtask"].includes(button.textContent.trim())); })()',
    label: 'decision starts folded and open card omits removed actions',
  })
  await b.evaluate({ code: 'window.foldedMaximum = Number(document.querySelector(".card.selected > .resize-y").getAttribute("aria-valuemax")); return true;' })
  await b.click({ selector: '.decision summary' })
  await b.eventually({
    condition: 'Number(document.querySelector(".card.selected > .resize-y").getAttribute("aria-valuemax")) > window.foldedMaximum',
    label: 'maximum height follows unfolding decision content',
  })
  await b.check({
    condition: 'document.querySelector(".decision").open && document.querySelector(".decision .disclosure-body").textContent.includes("The owner chose this in the design review")',
    label: 'decision unfolds with full question, answer and reason',
  })
  await b.screenshot({ name: 'card-redesign-open.png' })
  await b.click({ selector: '.decision summary' })
  await b.check({
    condition: '!document.querySelector(".decision").open',
    label: 'decision folds again',
  })
  await b.click({ selector: '.pending-question button' })
  await b.eventually({
    condition: 'document.activeElement?.getAttribute("aria-label") === "Reply to Hydra" && document.activeElement.value.includes("Choose the conversation layout")',
    label: 'declaration question prepares an answer in Hydra chat',
  })

  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const card = writer.state.cards[writer.state.keys.layout!]!
      const reply = decideReply({
        state: writer.state,
        ref: card.id,
        meta: {
          actor: 'web',
          at: new Date().toISOString(),
        },
        data: {
          reply: 'layout-delivered',
          state: 'delivered',
          route: 'fixture',
          decision: {
            questionId: card.status!.id,
            question: card.status!.note,
            answer: 'Keep Updates above chat',
          },
        },
      })

      if ('event' in reply) {
        writer.append({ event: reply.event })
      }
    },
  })
  await b.eventually({
    condition:'!document.querySelector(".pending-question") && [...document.querySelectorAll(".decision")].some(row=>!row.open && row.textContent.includes("Keep Updates above chat"))',
    label:'a delivered answer replaces the pending question with its folded Decision',
  })

  await b.check({
    condition:'[...document.querySelectorAll(".hydra-chat .task-reference")].every(ref=>ref.textContent.includes("Choose the conversation layout") && ref.querySelector(".task-reference-state")?.getAttribute("aria-label") === "Needs you" && ref.querySelectorAll("svg").length === 3 && ref.querySelector("svg").classList.contains("tabler-icon-calendar") && !ref.textContent.includes("Needs you"))',
    label:'header and inline references show calendar, status icon, live title and open icon',
  })
  await b.click({selector:'.hydra-chat .markdown .task-reference'})
  await b.eventually({
    condition:'!!document.querySelector(".card.selected")',
    label:'inline reference opens the task',
  })

  await b.click({ selector: '.card-metadata summary' })

  for (const width of [
    390,
    1440,
  ]) {
    await b.browser({
      args: [
        'resize',
        String(width),
        '1000',
      ],
    })
    await b.check({
      condition: '(() => { const card = document.querySelector(".card"); return [...card.querySelectorAll(".card-link")].every(link => link.getBoundingClientRect().right <= card.getBoundingClientRect().right); })()',
      label: `link titles stay inside the card at ${width}px`,
    })
  }

  commands.task([
    'rename',
    'layout',
    '--title',
    'Updated layout title',
  ])
  commands.task([
    'status',
    'layout',
    'done',
    '--note',
    'Decision implemented',
  ])
  commands.move([
    'layout',
    'done',
    '--actor',
    'web',
  ])
  await b.eventually({
    condition:'[...document.querySelectorAll(".hydra-chat .task-reference")].every(ref=>ref.textContent.includes("Updated layout title") && ref.querySelector(".task-reference-state")?.getAttribute("aria-label").startsWith("Done"))',
    label:'old chat references track live title and completion',
  })
  await b.check({
    condition:'[...document.querySelectorAll(".hydra-chat .task-reference")].every(ref=>ref.classList.contains("column-done") && getComputedStyle(ref).getPropertyValue("--column-color") === getComputedStyle(document.querySelector(".column-done")).getPropertyValue("--column-color"))',
    label:'reference colors follow the live column after a move',
  })
} finally {
  await b.close()
  await server.close()
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
