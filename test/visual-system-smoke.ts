import { hydraSdk } from './hydra-host-fixture.ts'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from '../src/cli/commands.ts'
import { decidePush, decideView } from '../src/core/decide.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { COLUMNS } from '../src/core/model.ts'
import { startServer } from '../src/server/server.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { smokeBrowser } from './browser.ts'
import { seedWebFixture } from './web-fixture.ts'

const home = mkdtempSync(join(
  tmpdir(),
  'pnyx-visual-smoke-',
))
process.env.PNYX_HOME = home; process.env.PNYX_SEMANTIC = 'off'
process.env.CLAUDE_CONFIG_DIR = join(
  home,
  'claude',
)
const fixture = seedWebFixture({ home })
appendFileSync(
  fixture.transcript,
  `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-16T10:00:00Z',
    message: {
      content: [
        {
          type: 'text',
          text: '## Release notes\n\nInline `ready`.\n\n```typescript\nconst ready = true\n```',
        },
      ],
    },
  })}\n`,
)
commands.task([
  'create',
  '--key',
  'queue',
  '--title',
  'Plan the next release',
  '--column',
  'queued',
])
withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const meta = {
      actor: 'fixture',
      at: '2026-10-16T10:00:00Z',
    }

    const message = hydraEvent({
      state: writer.state,
      meta,
      cardId: '$board',
      change: {
        type: 'hydra.message',
        data: {
          action: 'send',
          text: 'Review the release checklist with **clear labels**.',
          hydra: 'hydra',
        },
      },
    })
    assert.ok('event' in message); writer.append({ event: message.event })

    for (const key of [
      'queue',
      'layout',
      'coverage',
      'review',
      'docs',
    ]) {
      const result = decidePush({
        state: writer.state,
        key,
        input: {
          project: 'payments-api',
          tags: ['release'],
        },
        meta,
      })
      assert.ok('event' in result); writer.append({ event: result.event })
    }

    const result = decideView({
      state: writer.state,
      meta,
      patch: {
        hydraWidth: 240,
        columnWidths: Object.fromEntries(COLUMNS.map(id => [
          id,
          240,
        ])),
      },
    })
    assert.ok('event' in result); writer.append({ event: result.event })
  },
})
commands.task([
  'status',
  fixture.state.keys.layout!,
  'working',
  '--note',
  '## Release notes\n\nInline `ready`.\n\n```typescript\nconst ready = true\n```',
])
const server = await startServer({
  query: hydraSdk().query,
  hydraId: 'default',
  homes: [fixture.nativeHome],
})
const {
  browser,
  check,
  eventually,
  click,
  text,
  fill,
  press,
  focus,
  screenshot,
  close,
  evaluate,
} = smokeBrowser({
  home,
  session: 'pnyx-visual',
})

try {
  await browser({
    args: [
      'open',
      server.url,
    ],
  })
  await browser({
    args: [
      'resize',
      '1800',
      '1000',
    ],
  })
  await browser({
    args: [
      'wait',
      'Plan the next release',
    ],
  })
  await evaluate({ code: 'await document.fonts.ready; return true;' })

  for (const theme of [
    'light',
    'dark',
  ]) {
    commands.view([
      'set',
      '--json',
      JSON.stringify({ theme }),
    ])
    await eventually({
      condition: `document.documentElement.dataset.theme === '${theme}'`,
      label: `${theme} theme applied`,
    })
    await screenshot({ name: `hydra-${theme}.png` })
    await evaluate({
      code: `
      const luminance = ({ color }) => {
        const channels = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      for (const surface of ['--color-background', '--color-surface', '--color-raised', '--color-hover']) {
        for (const ink of ['--color-ink', '--color-muted']) {
          const probe = document.createElement('span');
          probe.style.color = 'var(' + ink + ')'; probe.style.backgroundColor = 'var(' + surface + ')';
          document.querySelector('.app').append(probe);
          const style = getComputedStyle(probe);
          const foreground = luminance({ color: style.color }), background = luminance({ color: style.backgroundColor });
          probe.remove();
          if ((Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) < 4.5) throw new Error('Insufficient text contrast: ' + ink + ' on ' + surface);
        }
      }
      return 'Text contrast meets 4.5:1';
    `,
    })
    await check({
      condition: '[\'queued\',\'in_progress\',\'needs_you\',\'parked\',\'done\'].every(id => { const column = document.querySelector(\'[data-column="\'+id+\'"]\'); const heading = column.querySelector(\'h2\'); return !!heading.querySelector(\'svg\') && heading.textContent.trim().length > 0 && getComputedStyle(column).backgroundColor !== getComputedStyle(document.documentElement).backgroundColor; })',
      label: `${theme} columns have tinted wells, text and state icons`,
    })
    await check({
      condition: 'new Set([...document.querySelectorAll(\'.column-header h2 .inline-title\')].map(el => getComputedStyle(el).color)).size === 5',
      label: `${theme} column headings have five distinct mineral colors`,
    })
    await check({
      condition: 'new Set([...document.querySelectorAll(\'.column\')].map(el => getComputedStyle(el).backgroundColor)).size === 5 && [...document.querySelectorAll(\'.column\')].every(column => { const heading = getComputedStyle(column.querySelector(\'h2\')); const badge = getComputedStyle(column.querySelector(\'.count\')); return getComputedStyle(column).borderTopWidth === \'3px\' && getComputedStyle(column).borderTopColor === heading.color && Number(heading.fontWeight) >= 700 && badge.backgroundColor === heading.color; })',
      label: `${theme} tinted wells, top accents and count badges carry each column color`,
    })
    await evaluate({
      code: `
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      const luminance = ({ color }) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => { const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
      const contrast = ({ a, b }) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      for (const column of document.querySelectorAll('.column')) {
        const well = luminance({ color: getComputedStyle(column).backgroundColor });
        const heading = luminance({ color: getComputedStyle(column.querySelector('h2')).color });
        const badge = getComputedStyle(column.querySelector('.count'));
        if (contrast({ a: well, b: heading }) < 4.5 || contrast({ a: luminance({ color: badge.color }), b: luminance({ color: badge.backgroundColor }) }) < 4.5) throw new Error('Low column contrast: ' + column.getAttribute('aria-label'));
      }
      return 'Column headings and counts meet 4.5:1 contrast';
    `,
    })
    await check({
      condition: '[...document.querySelectorAll(\'.task-label\')].every(el => el.dataset.labelColor && getComputedStyle(el).borderTopStyle === \'solid\' && getComputedStyle(el).backgroundColor !== \'rgba(0, 0, 0, 0)\')',
      label: `${theme} project labels and tags have a saved color, fill and outline`,
    })
    const resting = await browser({
      args: [
        'snapshot',
        '--full',
      ],
    })
    const settings = resting.match(/uid=(\S+) button "Settings"/)
    assert.ok(
      settings,
      resting,
    )
    await browser({
      args: [
        'hover',
        `@${settings[1]}`,
      ],
    })
    await evaluate({ code: 'const title=document.querySelector(".card-open");window.restingTitleColor=getComputedStyle(title).color;window.hoverTitleLabel=title.getAttribute("aria-label");title.setAttribute("aria-label","Title hover probe");return true;' })
    const snapshot = await browser({
      args: [
        'snapshot',
        '--full',
      ],
    })
    const title = snapshot.match(/uid=(\S+) button "Title hover probe"/)
    assert.ok(
      title,
      snapshot,
    )
    await browser({
      args: [
        'hover',
        `@${title[1]}`,
      ],
    })
    await check({
      condition:'document.querySelector(".card-open").matches(":hover") && getComputedStyle(document.querySelector(".card-open")).color === window.restingTitleColor',
      label:`${theme} title keeps its foreground color on a real pointer hover`,
    })
    await evaluate({code:'document.querySelector(".card-open").setAttribute("aria-label",window.hoverTitleLabel);return true;'})
  }

  await check({
    condition: '[...document.fonts].some(f => f.family === \'GFS Neohellenic\' && f.weight === \'700\' && f.status === \'loaded\') && [\'.brand\', \'.hydra-head\', \'.column-header h2 .inline-title\'].every(selector => { const style = getComputedStyle(document.querySelector(selector)); return style.fontFamily.includes(\'GFS Neohellenic\') && style.fontWeight === \'700\' && style.letterSpacing === \'normal\'; })',
    label: 'brand and pane headings use the bundled GFS Bold face with natural spacing',
  })
  await check({
    condition: '[\'.app\', \'.card-open\', \'.task-label\', \'.left-panel nav > button\', \'.hydras-heading h2\'].every(selector => { const style = getComputedStyle(document.querySelector(selector)); return style.fontFamily.includes(\'-apple-system\') && !style.fontFamily.includes(\'GFS Neohellenic\') && style.letterSpacing === \'normal\' && style.fontSynthesis === \'none\'; })',
    label: 'controls, card titles, metadata and navigation use system sans without synthetic faces or tightened spacing',
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(\'.hydra-chat .markdown\')).fontSize === \'16px\' && getComputedStyle(document.querySelector(\'.hydra-chat .markdown\')).fontFamily.includes(\'-apple-system\') && parseFloat(getComputedStyle(document.querySelector(\'.hydra-chat .markdown\')).lineHeight) >= 25',
    label: 'Hydra conversation uses system sans at 16px with comfortable leading',
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(\'.card-open\')).fontSize === \'14px\' && getComputedStyle(document.querySelector(\'.column-header h2 .inline-title\')).fontSize === \'18px\' && getComputedStyle(document.querySelector(\'.task-label\')).fontSize === \'12px\'',
    label: 'card titles, pane headings and metadata use the accepted size scale',
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(\'.hydra-head .hydra-icon\')).maskImage.includes(\'hydra-lorc.svg\') && document.querySelector(\'.brand img\').getAttribute(\'src\') === \'/favicon.svg\' && document.querySelectorAll(\'.left-panel nav > button svg\').length === 1',
    label: 'Hydra mask, existing Pnyx favicon and navigation icons identify the interface',
  })
  await focus({ selector: '.column-header .inline-title' }); await press({ key: 'Enter' })
  await eventually({
    condition: '!!document.querySelector(\'.column-header h2 form input\')',
    label: 'column title editor opens',
  })
  await check({
    condition: '[...document.querySelectorAll(\'.column-header h2 form input, .column-header h2 form button\')].length === 3 && [...document.querySelectorAll(\'.column-header h2 form input, .column-header h2 form button\')].every(el => getComputedStyle(el).fontFamily.includes(\'-apple-system\') && !getComputedStyle(el).fontFamily.includes(\'GFS Neohellenic\'))',
    label: 'column title input and actions use system sans inside a pane heading',
  })
  await press({ key: 'Escape' })
  await eventually({
    condition: '!!document.querySelector(\'.column-header .inline-title\') && !document.querySelector(\'.column-header h2 form\')',
    label: 'column title editing cancels without saving',
  })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({
    condition: '!!document.querySelector(\'.task-updates .code-block\')',
    label: 'synthetic worker update appears',
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(\'.task-updates .markdown\')).fontSize === \'16px\' && getComputedStyle(document.querySelector(\'.task-updates .markdown\')).fontFamily.includes(\'-apple-system\')',
    label: 'Updates use system sans at the chat size',
  })
  await check({
    condition: 'getComputedStyle(document.querySelector(\'.detail .markdown h2\')).fontFamily.includes(\'-apple-system\') && getComputedStyle(document.querySelector(\'.detail .markdown h2\')).fontWeight === \'700\' && getComputedStyle(document.querySelector(\'.detail .markdown h2\')).letterSpacing === \'normal\'',
    label: 'message headings keep the conversation font and natural spacing',
  })
  await check({
    condition: '!!document.querySelector(\'.detail .code-block code\') && [\'.task-updates\'].every(selector => document.querySelector(selector + \' .code-block code\') && document.querySelector(selector + \' .markdown p code\')) && [...document.querySelectorAll(\'.detail .markdown code\')].every(el => getComputedStyle(el).fontFamily.includes(\'JetBrains Mono\') && getComputedStyle(el).fontSize === \'13px\')',
    label: 'inline and fenced Markdown keep JetBrains Mono and the accepted code size',
  })
  await click({ selector: '.card.selected .card-open' })
  await text({ label: 'Settings' })
  await check({
    condition: '[\'.settings h1\', \'.settings-box h2\'].every(selector => { const style = getComputedStyle(document.querySelector(selector)); return style.fontFamily.includes(\'GFS Neohellenic\') && style.fontWeight === \'700\' && style.letterSpacing === \'normal\'; }) && getComputedStyle(document.querySelector(\'.number-field\')).fontFamily.includes(\'-apple-system\')',
    label: 'Settings separates GFS pane headings from system sans labels',
  })
  await click({ selector: '.about summary' })
  await evaluate({ code: 'document.querySelector(\'.about\').scrollIntoView(); return true;' })
  await check({
    condition: 'document.querySelector(\'.about\').textContent.includes(\'Hydra by Lorc\') && document.querySelector(\'.about\').textContent.includes(\'CC BY 3.0\') && document.querySelector(\'.about a[href="/fonts/gfs-neohellenic/OFL.txt"]\') && document.querySelector(\'.about a[href="/licenses/tabler-icons.txt"]\')',
    label: 'Settings About exposes icon attribution and local font and icon licenses',
  })
  await evaluate({ code: 'for (const path of [\'/fonts/gfs-neohellenic/OFL.txt\', \'/licenses/tabler-icons.txt\', \'/icons/hydra-lorc.svg\']) { const response = await fetch(path); if (!response.ok || !(await response.text()).length) throw new Error(\'Missing asset \'+path); } return true;' })
  await screenshot({ name: 'license-notices.png' })

  for (const [
    label,
    value,
  ] of [
      [
        'UI font size',
        '18',
      ],
      [
        'Chat font size',
        '20',
      ],
      [
        'Code font size',
        '15',
      ],
    ]) {
    await focus({ selector: `[aria-label="${label}"]` }); await fill({
      label,
      value,
    }); await press({ key: 'Enter' })
    await eventually({
      condition: `document.querySelector('[aria-label="${label}"]').value === '${value}' && document.querySelector('[aria-label="${label}"]').closest('.number-field').getAttribute('aria-busy') === 'false'`,
      label: `${label} saved through Settings`,
    })
  }

  await eventually({
    condition: 'getComputedStyle(document.querySelector(\'.app\')).fontSize === \'18px\'',
    label: 'saved font preference applies',
  })
  await click({ selector: '[data-hydra-current]' })
  await check({
    condition: 'Math.abs(parseFloat(getComputedStyle(document.querySelector(\'.column-header h2 .inline-title\')).fontSize) - 18 * 9 / 7) < .01 && Math.abs(parseFloat(getComputedStyle(document.querySelector(\'.task-label\')).fontSize) - 18 * 6 / 7) < .01',
    label: 'pane headings and metadata follow the saved UI font preference',
  })
  await click({ selector: `[data-card="${fixture.state.keys.layout}"]` })
  await eventually({
    condition: 'document.querySelector(\'.task-updates .markdown\') && getComputedStyle(document.querySelector(\'.task-updates .markdown\')).fontSize === \'20px\'',
    label: 'saved chat font size applies independently',
  })
  await check({
    condition: '[\'.task-updates\'].every(selector => document.querySelector(selector + \' .code-block code\') && document.querySelector(selector + \' .markdown p code\')) && [...document.querySelectorAll(\'.detail .markdown code\')].every(el => getComputedStyle(el).fontSize === \'15px\') && getComputedStyle(document.querySelector(\'.detail .code-block pre\')).fontSize === \'15px\'',
    label: 'inline and fenced code follow the independent saved code font size',
  })
  const colors = loadHydra({ hydraId: 'default' }).state.labelColors
  assert.ok(colors?.some(entry => entry.label === 'payments-api'))
  process.stdout.write('Visual system smoke passed.\n')
} finally {
  await close(); await server.close(); rmSync(
    home,
    {
      recursive: true,
      force: true,
    },
  )
}
