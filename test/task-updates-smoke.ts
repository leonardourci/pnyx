import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { startServer } from '../src/server/server.ts'
import { smokeBrowser } from './browser.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { decidePush } from '../src/core/decide.ts'
import { withWriter } from '../src/store/hydra-store.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-updates-smoke-',
))
process.env.PNYX_HOME = home
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
process.env.PNYX_SEMANTIC = 'off'
commands.hydra([
  'create',
  'default',
])
commands.task([
  'create',
  '--key',
  'migration',
  '--title',
  'Check the migration',
  '--brief',
  'Review the rollback path.',
  '--column',
  'in_progress',
])
commands.task([
  'status',
  'migration',
  'working',
  '--note',
  'Migration checks pass. Reviewing the rollback path.',
  '--actor',
  'worker',
])
commands.task([
  'status',
  'migration',
  'needs_you',
  '--note',
  'Which canary should receive the migration first?',
  '--actor',
  'worker',
])
const appendHistory = ({
  title,
  noise,
}: {
  title: string
  noise: number
}) => withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    for (let index = 0; index <= noise; index++) {
      const decision = decidePush({
        state: writer.state,
        key: 'migration',
        input: index === 0 ? { title } : {
          folder: join(
            home,
            `noise-${title}-${index}`,
          ),
        },
        meta: {
          actor: 'fixture',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    }
  },
})
appendHistory({
  title: 'Older migration rename',
  noise: 550,
})
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
})
const b = smokeBrowser({
  home,
  session: 'pnyx-updates',
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
      '900',
    ],
  })
  await b.eventually({
    condition: '!!document.querySelector(".card-open")',
    label: 'task appears',
  })
  await b.click({ selector: '.card-open' })
  await b.eventually({
    condition: '!!document.querySelector(".task-updates button:not(.updates-order)") && !document.querySelector(".task-updates [role=status]")',
    label: 'Updates loads existing factual history',
  })
  await b.check({
    condition: '!document.querySelector(".detail [role=tab], .detail .composer, .detail .thread")',
    label: 'open card contains Updates without tabs, conversation or composer',
  })
  await b.check({
    condition: 'document.querySelector(".task-updates li").textContent.includes("Which canary")',
    label: 'newest declaration shows state, note and time',
  })
  await b.evaluate({
    code:`
    const send=WebSocket.prototype.send;
    window.olderIds=new Set();window.refreshIds=new Set();
    WebSocket.prototype.send=function(data){
      const message=JSON.parse(data);
      if(message.type==='command' && message.name==='history'){
        const older=message.args.includes('--before');
        (older?window.olderIds:window.refreshIds).add(message.id);
        if(older && !window.releaseOlder){
          const receive=this.onmessage;
          this.onmessage=function(event){
            receive.call(this,event);
            const result=JSON.parse(event.data);
            if(Array.isArray(result.events)){
              if(window.refreshIds.has(result.id)) window.refreshed=true;
              if(window.olderIds.has(result.id) && result.events.length<50) requestAnimationFrame(()=>requestAnimationFrame(()=>{window.olderFinished=true}));
            }
          };
          window.releaseOlder=()=>send.call(this,data);
          return;
        }
      }
      return send.call(this,data);
    };
    return true;
  `,
  })
  await b.text({ label: 'Older updates' })
  await b.eventually({
    condition:'typeof window.releaseOlder === "function"',
    label:'An older-page request waits while new events arrive',
  })
  appendHistory({
    title:'Overlapping migration rename',
    noise:60,
  })
  await b.eventually({
    condition:'window.refreshed && !document.querySelector(".task-updates [role=status]")',
    label:'A refresh replaces the cached range while Older is pending',
  })
  await b.evaluate({code:'window.releaseOlder();return true;'})
  await b.eventually({
    condition:'window.olderFinished',
    label:'The old range finishes after the refresh',
  })
  await b.check({
    condition:'[...document.querySelectorAll(".task-updates button")].some(button=>button.textContent === "Older updates") && !document.querySelector(".task-updates").textContent.includes("Created")',
    label:'A stale Older response cannot hide pagination or append across a refresh gap',
  })
  await b.text({ label: 'Older updates' })
  await b.eventually({
    condition:'document.querySelector(".task-updates")?.textContent.includes("Overlapping migration rename") && !document.querySelector(".task-updates [role=status]")',
    label:'Fresh pagination reaches the intermediate rename after the discarded response',
  })
  await b.text({ label: 'Older updates' })
  await b.eventually({
    condition: 'document.querySelector(".task-updates")?.textContent.includes("Older migration rename") && document.querySelector(".task-updates")?.textContent.includes("Created")',
    label: 'paging through noise reaches the older rename and creation',
  })
  await b.check({
    condition: '![...document.querySelectorAll(".task-updates button")].some(b => b.textContent === "Older updates") && !document.querySelector(".task-updates").textContent.includes("noise-")',
    label: 'exhausted history hides pagination and irrelevant events',
  })
  await b.evaluate({ code: 'window.newestRows = [...document.querySelectorAll(".task-updates > ol > li")].map(e => e.textContent); return true;' })
  await b.click({ selector: '.updates-order' })
  await b.check({
    condition: 'JSON.stringify([...document.querySelectorAll(".task-updates > ol > li")].map(e => e.textContent)) === JSON.stringify(window.newestRows.toReversed())',
    label: 'oldest-first reverses the full timeline',
  })
  await b.click({ selector: '.updates-order' })
  await b.check({
    condition: 'JSON.stringify([...document.querySelectorAll(".task-updates > ol > li")].map(e => e.textContent)) === JSON.stringify(window.newestRows)',
    label: 'newest-first restores the full timeline',
  })
  appendHistory({
    title: 'Burst migration rename',
    noise: 60,
  })
  await b.eventually({
    condition: '[...document.querySelectorAll(".task-updates button")].some(b => b.textContent === "Older updates")',
    label: 'a burst beyond one page restores access to intermediate history',
  })
  await b.text({ label: 'Older updates' })
  await b.eventually({
    condition: 'document.querySelector(".task-updates")?.textContent.includes("Burst migration rename")',
    label: 'the relevant event inside a refresh gap remains reachable',
  })
  await b.check({
    condition: '(() => { const rows = [...document.querySelectorAll(".task-updates > ol > li")].map(e => e.textContent); return new Set(rows).size === rows.length; })()',
    label: 'paging and refresh do not duplicate timeline rows',
  })
  commands.task([
    'status',
    'migration',
    'paused',
    '--note',
    'Waiting for the canary decision.\n\n1. Choose a canary.\n2. Confirm the rollout.',
    '--actor',
    'worker',
  ])
  await b.eventually({
    condition: 'document.querySelector(".task-updates li")?.textContent.includes("Waiting for the canary decision")',
    label: 'worker declarations arrive without a refresh',
  })

  await b.check({
    condition: '(() => { const list = document.querySelector(".task-updates .markdown ol"); return getComputedStyle(list).listStyleType === "decimal" && parseFloat(getComputedStyle(list).paddingLeft) > 0 && getComputedStyle(list.querySelector("li")).borderBottomWidth === "0px"; })()',
    label: 'numbered steps keep their markers and are not styled as timeline rows',
  })

  for (const [
    width,
    height,
    size,
  ] of [
      [
        1440,
        900,
        'desktop',
      ],
      [
        390,
        844,
        'phone',
      ],
    ] as const) {
    await b.browser({
      args: [
        'emulate',
        '--viewport',
        `${width}x${height}x1${size === 'phone' ? ',mobile,touch' : ''}`,
      ],
    })

    if (size === 'phone') {
      await b.press({ key: process.platform === 'darwin' ? 'Meta+b' : 'Control+b' })
    }

    await b.evaluate({ code: 'document.querySelector(".card.selected").scrollIntoView({ block: "nearest", inline: "center" }); return true;' })

    for (const theme of [
      'light',
      'dark',
    ]) {
      commands.view([
        'set',
        '--json',
        JSON.stringify({ theme }),
      ])
      await b.eventually({
        condition: `document.documentElement.dataset.theme === '${theme}'`,
        label: `${theme} theme`,
      })
      await b.check({
        condition: '(() => { const stream = document.querySelector(".task-updates"); const card = document.querySelector(".card.selected"); return stream.clientHeight >= 150 && stream.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom && stream.scrollWidth <= stream.clientWidth; })()',
        label: `${size} ${theme} updates remain readable inside the card`,
      })
      await b.screenshot({ name: `updates-${size}-${theme}.png` })
    }
  }

  assert.doesNotMatch(
    await b.browser({ args: ['console'] }),
    /TypeError|ReferenceError|Uncaught/,
  )
  process.stdout.write('Task updates browser smoke passed.\n')
} catch (error) {
  writeFileSync(
    join(
      process.env.PNYX_EVIDENCE_DIR ?? home,
      'updates-failure.txt',
    ),
    await b.evaluate({ code: 'return document.documentElement.outerHTML;' }),
  )
  await b.screenshot({ name: 'updates-failure.png' })
  throw error
} finally {
  await b.close(); await server.close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
