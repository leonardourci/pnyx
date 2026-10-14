# Keyboard and local catalogs

Pnyx uses the focused area, not a global typing mode. Card buttons have one Tab
stop per column. Arrows and h/j/k/l move between cards and columns, stopping at the
edges and remembering each column's last card. Empty columns remain reachable.
Home/End reach the first/last card. Enter opens the conversation; r focuses its
composer. In the conversation, arrows and j/k scroll, PageUp/PageDown move a page,
and Home/End reach the first/latest loaded content.

Enter in the composer adds a newline. Mod+Enter sends once, using the existing
reply queue and receipts. Escape dismisses suggestions first, leaves the composer
next, then closes the detail and returns to the board. Drafts survive that loop.
Text fields do not trigger board shortcuts, including Mod+K, except for finding
in the current view. Mod+F focuses Find a card on the board or Search history in
History, including from a text field. It leaves browser find available in Settings
and overlays, or when unbound. Composition, dead keys, AltGraph, and held
send/move keys never submit actions. Escape runs that
loop only from the composer, overlays and non-text focus. In search and filter
fields it clears the text, then an empty field returns focus to the board without
closing the open conversation; other fields keep Escape for themselves.

Other defaults are m for manual placement, / for history search, Mod+F for finding
in the current view, Mod+K for Commands, ? for help, f for visible target hints,
and Mod+, for Settings. Mod is
Command on macOS and Control elsewhere. Browsers, extensions or the OS may reserve
Mod+,; the Settings button and Commands remain fallbacks. There are no extra
single-key pin, filter, link-opening or trace-toggle shortcuts.

Hints label visible enabled controls, links, reading regions and resize handles.
Type a label to focus or activate its target. Labels remain fixed until exit;
scrolling, resizing, pointer input and Tab dismiss them. Backspace corrects a
partial label. The cancel binding also dismisses hints.

Settings contains every application binding. Use logical key names such as
ArrowDown, modifiers such as Mod+Enter, and up to three space-separated strokes
such as g s. Each action supports four alternatives, entered one per line. Save,
unbind, reset an action or reset all bindings through normal board view events.
Conflicts are checked in overlapping scopes on both Mac and other platforms.
Send must keep a command modifier so plain Enter can never submit a reply.
Standard widget keys (Tab, combobox arrows, resize arrows and text editing) retain
their accessible control behavior. The Character shortcuts switch disables
printing-key shortcuts and sequences while keeping arrows, command shortcuts and
visible buttons available.

## Slash suggestions

A leading / in the composer opens a catalog for the card's recorded harness and
working folder. Arrows select, Enter inserts, and the cancel binding dismisses
without altering text. Paths and prose containing a slash stay ordinary text.
Selection never executes a skill, expands file contents, or sends a reply.

- Claude Code: personal and project `.claude/skills` and `.claude/commands`, plus
  applicable installed plugins enabled in merged user/project/local settings.
  Skill metadata wins over a command with the same name; personal skills win
  over project skills. Hidden skills and `skillOverrides` set to `off` are omitted.
  Plugin commands retain `/plugin:name` syntax.
- Codex: personal and project `.agents/skills`, plus top-level Markdown prompts
  in the Codex home's `prompts` folder. Skills insert `$name`; prompts insert
  `/prompts:name`. The slash menu is a picker for both native forms.

Project folders extend from the recorded working folder through its repository
root; outside a repository, only the working folder is used. Personal roots use
the server user's home, respecting CLAUDE_CONFIG_DIR and CODEX_HOME. Catalogs are
local file discovery, not proof that a running harness has reloaded those files
or enabled every item in its runtime configuration. Unsupported, missing and
empty catalogs have explicit states, and commands can always be typed literally.
Pnyx reads metadata only, with limits of 1,000 filesystem reads/listings, 64 KiB per
file, 200 suggestions and six command-directory levels. Symlink cycles terminate;
skipped or invalid metadata produces a partial-discovery notice. Browser responses
contain command names, descriptions and scope labels, never file paths or bodies.

## Verification

`pnpm test` covers key resolution, platform modifiers, sequences, scope conflicts,
typing/IME protection, event replay/undo, focus destinations and catalog fixtures.
`pnpm test:keyboard` uses chrome-devtools-axi with an isolated PNYX_HOME and a fake
delivery route for actual key presses, remapping/reload, focus restoration,
slash insertion, placement and hints. `pnpm test:web` retains the board smoke.
Set PNYX_EVIDENCE_DIR to save screenshots outside the temporary fixture folder.
These checks do not substitute for manual screen-reader and other-browser testing.
