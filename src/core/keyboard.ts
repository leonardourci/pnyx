import { matchKeybindingPress, parseKeybinding, type KeybindingPress } from "tinykeys";

export type KeyScope = "board" | "thread" | "navigation" | "composer" | "overlay" | "hints";
export type KeyPlatform = "mac" | "other";
const navigation: KeyScope[] = ["board", "thread", "navigation"];
const action = (id: string, label: string, keys: string[], scopes: KeyScope[], repeat = false) => ({ id, label, keys, scopes, repeat });
export const KEY_ACTIONS = [
  action("board.up", "Previous card", ["ArrowUp", "k"], ["board"], true),
  action("board.down", "Next card", ["ArrowDown", "j"], ["board"], true),
  action("board.left", "Previous column", ["ArrowLeft", "h"], ["board"], true),
  action("board.right", "Next column", ["ArrowRight", "l"], ["board"], true),
  action("board.first", "First card", ["Home"], ["board"], true),
  action("board.last", "Last card", ["End"], ["board"], true),
  action("board.open", "Open conversation", ["Enter"], ["board"]),
  action("thread.up", "Scroll conversation up", ["ArrowUp", "k"], ["thread"], true),
  action("thread.down", "Scroll conversation down", ["ArrowDown", "j"], ["thread"], true),
  action("thread.pageUp", "Previous conversation page", ["PageUp"], ["thread"], true),
  action("thread.pageDown", "Next conversation page", ["PageDown"], ["thread"], true),
  action("thread.first", "First loaded message", ["Home"], ["thread"], true),
  action("thread.last", "Latest loaded message", ["End"], ["thread"], true),
  action("reply", "Focus reply composer", ["r"], ["board", "thread"]),
  action("send", "Send reply", ["Mod+Enter"], ["composer"]),
  action("cancel", "Close the current layer", ["Escape"], [...navigation, "composer", "overlay", "hints"]),
  action("move", "Move card", ["m"], ["board", "thread"]),
  action("search", "Search history", ["/"], navigation),
  action("palette", "Open commands", ["Mod+k"], navigation),
  action("help", "Keyboard help", ["?"], navigation),
  action("hints", "Show target hints", ["f"], navigation),
  action("settings", "Open settings", ["Mod+,"], navigation),
];
export interface KeyboardPreferences { characterShortcuts: boolean; bindings: Record<string, string[]> }
export const DEFAULT_KEYBOARD: KeyboardPreferences = { characterShortcuts: true, bindings: {} };
export const bindingsFor = (prefs: KeyboardPreferences, id: string) => prefs.bindings[id] ?? KEY_ACTIONS.find(a => a.id === id)?.keys ?? [];
const namedKeys = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", "Escape", "Backspace", "Delete", ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1))]);
const modifiers = ["Control", "Meta", "Alt", "Shift"];

export function parseBinding(binding: string, platform: KeyPlatform): KeybindingPress[] {
  return parseKeybinding(binding.trim().replace(/\s+/g, " ").replace(/(\$mod|\bMod)(?=\+)/g, platform === "mac" ? "Meta" : "Control")).map(([required, optional, key]) => {
    // Symbols use their logical key on layouts with or without Shift.
    const implicitShift = typeof key === "string" && key.length === 1 && /[^a-z0-9]/i.test(key) && !required.includes("Shift");
    return [required, implicitShift ? [...optional, "Shift"] : optional, key];
  });
}
const printable = (p: KeybindingPress) => typeof p[2] === "string" && p[2].length === 1 && !p[0].some(m => ["Control", "Meta", "Alt"].includes(m));
export const characterBinding = (binding: string, platform: KeyPlatform) => parseBinding(binding, platform).some(printable);
const samePress = (a: KeybindingPress, b: KeybindingPress) => {
  if (String(a[2]).toLowerCase() !== String(b[2]).toLowerCase()) return false;
  return modifiers.every(m => !(a[0].includes(m) && !b[0].includes(m) && !b[1].includes(m)) && !(b[0].includes(m) && !a[0].includes(m) && !a[1].includes(m)));
};
export function keyboardError(prefs: KeyboardPreferences): string | undefined {
  const all: { id: string; binding: string; strokes: KeybindingPress[]; scopes: KeyScope[] }[] = [];
  for (const id of Object.keys(prefs.bindings)) if (!KEY_ACTIONS.some(a => a.id === id)) return "Unknown keyboard action: " + id;
  for (const platform of ["mac", "other"] as const) {
    all.length = 0;
    for (const a of KEY_ACTIONS) {
      const keys = bindingsFor(prefs, a.id);
      if (!Array.isArray(keys) || keys.length > 4) return "Use at most four bindings for " + a.label;
      for (const binding of keys) {
        if (typeof binding !== "string" || !binding.trim() || binding.length > 100) return "Invalid binding for " + a.label;
        let strokes: KeybindingPress[];
        try { strokes = parseBinding(binding, platform); } catch { return "Invalid key syntax: " + binding; }
        if (strokes.length > 3 || strokes.some(([required, optional, key]) =>
          new Set(required).size !== required.length || required.some(m => !modifiers.includes(m)) || optional.some(m => m !== "Shift") ||
          typeof key !== "string" || (!namedKeys.has(key) && ([...key].length !== 1 || /\s/.test(key))))) return "Use logical keys, modifiers and up to three space-separated keys: " + binding;
        if (strokes.some(([mods, , key]) => (mods.some(m => m === "Control" || m === "Meta") && /^(l|t|w|r|f|p|q|n|\+|-|=|0)$/i.test(String(key))) || (mods.includes("Alt") && ["ArrowLeft", "ArrowRight"].includes(String(key))))) return "Reserved browser shortcut: " + binding;
        if ((a.id === "send" || a.id === "cancel") && strokes.some(printable)) return "Typing must remain literal: " + a.label + " needs a non-printing key or a command modifier";
        if (a.id === "cancel" && strokes.some(([mods, , key]) => !mods.some(m => ["Control", "Meta", "Alt"].includes(m)) && key !== "Escape" && !/^F\d+$/.test(String(key)))) return "Close the current layer needs Escape, a function key, or a command modifier; keep editing keys available";
        if (a.id === "send" && strokes.some(([mods]) => !mods.some(m => m === "Control" || m === "Meta"))) return "Send reply needs Mod, Control or Meta; Enter always adds a newline";
        for (const prior of all) if (a.scopes.some(s => prior.scopes.includes(s)) && strokes.slice(0, Math.min(strokes.length, prior.strokes.length)).every((s, i) => samePress(s, prior.strokes[i]))) return "Shortcut conflicts with " + KEY_ACTIONS.find(x => x.id === prior.id)!.label + ": " + binding;
        all.push({ id: a.id, binding, strokes, scopes: a.scopes });
      }
    }
  }
}

export interface KeyInput {
  key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean; altGraph?: boolean;
}
export interface KeyContext { scope: KeyScope; editing?: boolean; characterShortcuts: boolean; platform: KeyPlatform; now: number }
export interface KeyProgress { candidates: { action: string; binding: string; next: number }[]; scope: KeyScope; until: number }
export const emptyProgress = (): KeyProgress => ({ candidates: [], scope: "navigation", until: 0 });
export function matchesPress(event: KeyInput, stroke: KeybindingPress): boolean {
  const wrapped = { ...event, code: event.code ?? "", getModifierState: (m: string) => ({ Control: !!event.ctrlKey, Meta: !!event.metaKey, Alt: !!event.altKey, Shift: !!event.shiftKey }[m] ?? false) };
  return matchKeybindingPress(wrapped as KeyboardEvent, stroke);
}
export function resolveKey(event: KeyInput, context: KeyContext, prefs: KeyboardPreferences, progress = emptyProgress()): { action?: string; consume: boolean; progress: KeyProgress } {
  const empty = { consume: false, progress: emptyProgress() };
  if (event.defaultPrevented || event.isComposing || event.altGraph || ["Process", "Dead", "Unidentified"].includes(event.key)) return empty;
  if (modifiers.includes(event.key)) return { consume: false, progress };
  const available = KEY_ACTIONS.filter(a => a.scopes.includes(context.scope) && (!context.editing || a.id === "send" || (a.id === "cancel" && context.scope !== "navigation")));
  const candidates = progress.scope === context.scope && context.now <= progress.until ? progress.candidates : [];
  const pending: KeyProgress["candidates"] = [];
  for (const a of available) for (const binding of bindingsFor(prefs, a.id)) {
    const strokes = parseBinding(binding, context.platform);
    if (!context.characterShortcuts && strokes.some(printable)) continue;
    if (event.repeat && !a.repeat) continue;
    const next = candidates.find(c => c.action === a.id && c.binding === binding)?.next ?? 0;
    if (!matchesPress(event, strokes[next])) continue;
    if (next + 1 === strokes.length) return { action: a.id, consume: true, progress: emptyProgress() };
    pending.push({ action: a.id, binding, next: next + 1 });
  }
  return { consume: pending.length > 0, progress: { candidates: pending, scope: context.scope, until: context.now + 1500 } };
}

export function keyLabel(keys: string[], platform: KeyPlatform): string {
  return keys.map(k => k.replace(/Mod\+/g, platform === "mac" ? "⌘+" : "Ctrl+").replace(/ArrowUp/g, "↑").replace(/ArrowDown/g, "↓").replace(/ArrowLeft/g, "←").replace(/ArrowRight/g, "→")).join(" / ") || "Unbound";
}
