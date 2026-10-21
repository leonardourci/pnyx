import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { decidePush } from '../src/core/decide.ts'
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
  await b.screenshot({ name: 'card-redesign-closed.png' })
  await b.evaluate({ code: 'window.cardHeight = document.querySelector(".card").getBoundingClientRect().height; document.querySelector(".card-since").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true;' })
  await b.eventually({
    condition: 'document.querySelector("[role=tooltip]")?.textContent.startsWith("Created ")',
    label: 'time tooltip shows creation date',
  })
  await b.check({
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
  await b.check({
    condition: '(() => { const fold = document.querySelector(".decision"); return !fold.open && fold.textContent.includes("Updates above chat") && fold.textContent.includes("by Hydra") && ![...document.querySelectorAll(".detail button")].some(button => ["Reassign", "Add subtask"].includes(button.textContent.trim())); })()',
    label: 'decision starts folded and open card omits removed actions',
  })
  await b.click({ selector: '.decision summary' })
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
  await b.click({ selector: '.card-question button' })
  await b.eventually({
    condition: 'document.activeElement?.getAttribute("aria-label") === "Reply to Hydra" && document.activeElement.value.includes("Choose the conversation layout")',
    label: 'declaration question prepares an answer in Hydra chat',
  })

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
