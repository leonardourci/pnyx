import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { HYDRA_CARD, hydraEvent } from '../src/core/hydra.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { startServer } from '../src/server/server.ts'
import { smokeBrowser } from './browser.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-card-navigation-',
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
const state = () => loadHydra({ hydraId: 'default' }).state
const columns = state().config!.columns
const columnA = columns.find(column => column.role === 'in_progress')!.id
const columnB = columns.find(column => column.role === 'parked')!.id

for (const [
  prefix,
  column,
] of [
    [
      'a',
      columnA,
    ],
    [
      'b',
      columnB,
    ],
  ]) {
  for (let index = 0; index < 12; index++) {
    commands.task([
      'create',
      '--key',
      `${prefix}${index}`,
      '--title',
      `Navigation ${prefix.toUpperCase()} ${index}`,
      '--column',
      column,
    ])
  }
}

const keys = state().keys
const a0 = keys.a0!, a1 = keys.a1!, b0 = keys.b0!, target = keys.b11!
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const decision = hydraEvent({
      state: writer.state,
      cardId: HYDRA_CARD,
      meta: {
        actor: 'fixture',
        at: new Date().toISOString(),
      },
      change: {
        type: 'hydra.message',
        data: {
          hydra: 'hydra',
          action: 'worker',
          text: [
            a0,
            a1,
            b0,
            target,
          ].map(id => `[@${writer.state.cards[id]!.title}](pnyx-task:${id})`).join(' · '),
        },
      },
    })
    assert.ok('event' in decision)
    writer.append({ event: decision.event })
  },
})
const server = await startServer({
  hydraId: 'default',
  query: hydraSdk().query,
  homes: [],
})
const b = smokeBrowser({
  home,
  session: 'pnyx-card-navigation',
})
const article = ({ id }: { id: string }) => `.card[data-task="${id}"]`
const reference = ({ id }: { id: string }) => `.hydra-chat [data-task-ref="${id}"]`
const selection = ({ ids }: { ids: string[] }) => `document.querySelectorAll('.card.selected').length === ${ids.length} && ${JSON.stringify(ids)}.every(id => document.querySelector('.card[data-task="' + id + '"]')?.classList.contains('selected'))`
const focused = ({ id }: { id: string }) => `document.activeElement?.matches('.task-updates') && document.activeElement.closest('.card')?.dataset.task === ${JSON.stringify(id)}`

const openCard = async ({
  id,
  fromReference = false,
}: {
  id: string
  fromReference?: boolean
}) => {
  await b.click({ selector: fromReference ? reference({ id }) : `${article({ id })} .card-state` })
  await b.eventually({
    condition: focused({ id }),
    label: `task ${id} opens and focuses its own Updates`,
  })
}

const resetProbe = async ({ hold = [] }: { hold?: string[] } = {}) => {
  await b.evaluate({
    code: `
    for (const element of window.nav.scrollers) {
      window.nav.nativeScrollTo.call(element, {left: 0, top: 0, behavior: 'instant'});
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.nav.calls = []; window.nav.ends = []; window.nav.hold = new Set(${JSON.stringify(hold)});
    return true;
  `,
  })
}

const bothEnded = `window.nav.ends.includes('kanban') && window.nav.ends.includes(${JSON.stringify(columnB)})`

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
      '1600',
      '1000',
    ],
  })
  await b.eventually({
    condition: `!!document.querySelector(${JSON.stringify(reference({ id: target }))}) && document.querySelectorAll('.card').length === 24`,
    label: 'synthetic cards and stable chat references render',
  })
  await openCard({ id: a0 })
  await openCard({
    id: b0,
    fromReference: true,
  })
  await b.check({
    condition: selection({
      ids: [
        a0,
        b0,
      ],
    }),
    label: 'different columns keep one card open each',
  })
  await openCard({ id: a1 })
  await b.check({
    condition: selection({
      ids: [
        a1,
        b0,
      ],
    }),
    label: 'opening a sibling replaces only its column',
  })
  await b.click({ selector: `${article({ id: a1 })} .card-state` })
  await b.eventually({
    condition: selection({ ids: [b0] }),
    label: 'closing a card preserves the other column',
  })
  await b.focus({ selector: `[data-card="${a0}"]` })
  await b.press({ key: 'Enter' })
  await b.eventually({
    condition: focused({ id: a0 }),
    label: 'keyboard opening focuses the requested task after navigation',
  })
  await b.focus({ selector: `${article({ id: b0 })} .task-updates` })
  await b.press({ key: 'Escape' })
  await b.eventually({
    condition: `${selection({ ids: [a0] })} && document.activeElement?.dataset.card === ${JSON.stringify(b0)}`,
    label: 'Escape closes the focused older card and returns to its title',
  })
  await openCard({
    id: b0,
    fromReference: true,
  })
  await b.evaluate({ code: 'location.reload(); return true;' })
  await b.eventually({
    condition: selection({
      ids: [
        a0,
        b0,
      ],
    }),
    label: 'reload restores the expanded card in each column',
  })
  await b.click({ selector: `${article({ id: a0 })} .card-state` })
  await b.click({ selector: `${article({ id: b0 })} .card-state` })
  await b.eventually({
    condition: selection({ ids: [] }),
    label: 'cards close independently after restoration',
  })
  await b.browser({
    args: [
      'resize',
      '1000',
      '640',
    ],
  })
  await b.evaluate({
    code: `
    await document.fonts.ready;
    const scrollers = [...document.querySelectorAll('.kanban, .column-cards')];
    const nativeScrollTo = HTMLElement.prototype.scrollTo;
    for (const element of scrollers) nativeScrollTo.call(element, {left: 0, top: 0, behavior: 'instant'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.nav = {scrollers, nativeScrollTo, calls: [], ends: [], hold: new Set(), reduced: false};
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = nativeMatchMedia(query);
      if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', {value: window.nav.reduced});
      return result;
    };
    const key = element => element.matches('.kanban') ? 'kanban' : element.closest('[data-column]').dataset.column;
    HTMLElement.prototype.scrollTo = function(...args) {
      if (scrollers.includes(this)) {
        const options = typeof args[0] === 'object' ? args[0] : {left: args[0], top: args[1]};
        window.nav.calls.push({key: key(this), behavior: options.behavior || 'auto', moving: Math.abs((options.left ?? this.scrollLeft) - this.scrollLeft) >= 1 || Math.abs((options.top ?? this.scrollTop) - this.scrollTop) >= 1});
      }
      return nativeScrollTo.apply(this, args);
    };
    for (const element of scrollers) {
      element.addEventListener('scrollend', event => {
        if (!event.isTrusted || event.target !== element) return;
        const name = key(element);
        window.nav.ends.push(name);
        if (window.nav.hold.has(name)) event.stopImmediatePropagation();
      }, {capture: true});
    }
    return true;
  `,
  })
  await b.check({
    condition: `document.querySelector('.kanban').scrollWidth > document.querySelector('.kanban').clientWidth && document.querySelector('[data-column="${columnB}"] .column-cards').scrollHeight > document.querySelector('[data-column="${columnB}"] .column-cards').clientHeight`,
    label: 'narrow short viewport requires both horizontal and vertical task navigation',
  })
  await resetProbe({
    hold: [
      'kanban',
      columnB,
    ],
  })
  await b.click({ selector: reference({ id: target }) })
  await b.eventually({
    condition: `['kanban', ${JSON.stringify(columnB)}].every(key => window.nav.calls.some(call => call.key === key && call.moving && call.behavior === 'smooth'))`,
    label: 'chat jump requests native smooth scrolling on both moving axes',
  })
  await b.eventually({
    condition: bothEnded,
    label: 'both native smooth scrolls finish before their held completion is released',
  })
  await b.check({
    condition: selection({ ids: [] }),
    label: 'task stays collapsed while completion is held',
  })
  await b.evaluate({
    code: `
    window.nav.hold.delete('kanban');
    document.querySelector('.kanban').dispatchEvent(new Event('scrollend'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  `,
  })
  await b.check({
    condition: selection({ ids: [] }),
    label: 'horizontal completion alone cannot expand the task',
  })
  await b.evaluate({
    code: `
    window.nav.hold.delete(${JSON.stringify(columnB)});
    document.querySelector('[data-column="${columnB}"] .column-cards').dispatchEvent(new Event('scrollend'));
    return true;
  `,
  })
  await b.eventually({
    condition: focused({ id: target }),
    label: 'both completions release task expansion and Updates focus',
  })
  await b.check({
    condition: `(() => {
      const task = document.querySelector(${JSON.stringify(article({ id: target }))});
      const pane = task.closest('.column-cards').getBoundingClientRect();
      const top = task.getBoundingClientRect().top;
      const kanban = task.closest('.kanban');
      const viewport = kanban.getBoundingClientRect();
      const column = task.closest('[data-column]').getBoundingClientRect();
      return top >= pane.top - 1 && top < pane.bottom && (column.width > kanban.clientWidth || (column.left >= viewport.left - 1 && column.right <= viewport.right + 1));
    })()`,
    label: 'navigation reveals the column and the requested card without fixed pixel expectations',
  })
  await b.click({ selector: `${article({ id: target })} .card-state` })
  await b.eventually({
    condition: selection({ ids: [] }),
    label: 'first navigation is closed before cancellation case',
  })
  await resetProbe({
    hold: [
      'kanban',
      columnB,
    ],
  })
  await b.click({ selector: reference({ id: target }) })
  await b.eventually({
    condition: bothEnded,
    label: 'first jump reaches its held completion boundary',
  })
  await b.evaluate({
    code: `
    window.nav.hold.clear();
    document.querySelector(${JSON.stringify(reference({ id: a1 }))}).click();
    return true;
  `,
  })
  await b.eventually({
    condition: focused({ id: a1 }),
    label: 'a newer jump cancels the waiting older jump',
  })
  await b.evaluate({
    code: `
    document.querySelector('.kanban').dispatchEvent(new Event('scrollend'));
    document.querySelector('[data-column="${columnB}"] .column-cards').dispatchEvent(new Event('scrollend'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  `,
  })
  await b.check({
    condition: selection({ ids: [a1] }),
    label: 'late old completion cannot reopen the cancelled task',
  })
  await resetProbe()
  await b.evaluate({ code: 'window.nav.reduced = true; return true;' })
  await b.click({ selector: reference({ id: target }) })
  await b.eventually({
    condition: focused({ id: target }),
    label: 'reduced-motion preference opens the task without animation',
  })
  await b.check({
    condition: `['kanban', ${JSON.stringify(columnB)}].every(key => window.nav.calls.some(call => call.key === key && call.moving && call.behavior === 'instant')) && window.nav.calls.filter(call => call.moving).every(call => call.behavior === 'instant')`,
    label: 'reduced motion makes both moving axes instant',
  })
  await b.check({
    condition: selection({
      ids: [
        a1,
        target,
      ],
    }),
    label: 'navigation preserves expanded cards in other columns',
  })
  const consoleOutput = await b.browser({ args: ['console'] })
  assert.doesNotMatch(
    consoleOutput,
    /TypeError|ReferenceError|Uncaught/,
  )
  process.stdout.write('Per-column expansion, restoration and cancellable smooth task navigation browser smoke passed.\n')
} finally {
  await server.close(); await b.close()
  rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
