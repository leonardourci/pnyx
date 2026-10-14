import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardState } from "../../../src/core/model.ts";
import { KEY_ACTIONS } from "../../../src/core/keyboard.ts";
import { Button } from "../components/ui/controls.tsx";
import { CommandMenu, type MenuItem } from "../components/ui/command-menu.tsx";
import type { Command } from "../board/connection.ts";
import { columnsFor } from "../board/view.ts";
import { focusElement, useKeyboard, type ActionContext } from "./registry.tsx";
import { navigate, restoreAnchor, type BoardAnchor, type ColumnCards } from "./navigation.ts";
import { hintLabels, visibleTargets, type Hint } from "./hints.ts";

interface Overlay { kind: "palette" | "help" | "move"; context: ActionContext; card?: string; revision?: number }
const anchorElement = (anchor: BoardAnchor) => anchor.card ? `[data-card="${CSS.escape(anchor.card)}"]` : `[data-empty-column="${CSS.escape(anchor.column)}"]`;
const readAnchor = (target: HTMLElement): BoardAnchor | undefined => target.dataset.card ? { card: target.dataset.card, column: target.closest<HTMLElement>("[data-column]")!.dataset.column! } : target.dataset.emptyColumn ? { column: target.dataset.emptyColumn } : undefined;
export function useBoardKeyboard({ state, groups, page, setPage, selected, open, close, command, connected, notify, newColumn, cancelColumn }: {
  state: BoardState; groups: ColumnCards[]; page: string; setPage(page: string): void; selected: string | null; open(id: string): void; close(): void; command: Command; connected: boolean; notify(text: string): void; newColumn: boolean; cancelColumn(): void;
}) {
  const [remembered, setRemembered] = useState<Record<string, string>>({}), [overlay, setOverlay] = useState<Overlay | null>(null), [hints, setHints] = useState<Hint[]>([]), [hintPrefix, setHintPrefix] = useState("");
  const focus = useRef<{ anchor?: BoardAnchor; owned: boolean }>({ owned: false }), previous = useRef(groups), returnFocus = useRef<HTMLElement | null>(null), restoring = useRef(0);
  const signature = JSON.stringify(groups);
  useEffect(() => {
    const track = (e: FocusEvent) => {
      const target = e.target as HTMLElement, anchor = readAnchor(target);
      focus.current.owned = !!anchor;
      if (anchor) { focus.current.anchor = anchor; if (anchor.card) setRemembered(r => r[anchor.column] === anchor.card ? r : { ...r, [anchor.column]: anchor.card! }); }
    };
    document.addEventListener("focusin", track); return () => document.removeEventListener("focusin", track);
  }, []);
  useLayoutEffect(() => {
    if (page === "board" && focus.current.owned && focus.current.anchor) {
      const restored = restoreAnchor(groups, previous.current, focus.current.anchor);
      if (document.activeElement === document.body || !document.activeElement?.isConnected) {
        focusElement(anchorElement(restored));
        if (restored.card !== focus.current.anchor.card) notify("Board focus moved to the nearest visible card.");
      }
    }
    previous.current = groups;
  }, [signature, page]); // The serialized groups capture only focus-relevant changes.
  useEffect(() => {
    if (!hints.length) return;
    const cancel = () => { setHints([]); setHintPrefix(""); };
    window.addEventListener("resize", cancel); document.addEventListener("scroll", cancel, true); document.addEventListener("pointerdown", cancel, true);
    return () => { window.removeEventListener("resize", cancel); document.removeEventListener("scroll", cancel, true); document.removeEventListener("pointerdown", cancel, true); };
  }, [hints]);
  useEffect(() => { setHints([]); setHintPrefix(""); }, [state.seq]);
  const focusDetail = (composer: boolean) => requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>("[data-conversation-tab]")?.click();
    requestAnimationFrame(() => focusElement(composer ? ".composer textarea" : "[data-key-scope=thread]"));
  });
  const closeOverlay = () => { setOverlay(null); restoring.current = requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (focus.current.anchor) focusElement(anchorElement(restoreAnchor(groups, previous.current, focus.current.anchor))); }); };
  const showOverlay = (kind: Overlay["kind"], context: ActionContext) => {
    cancelAnimationFrame(restoring.current);
    returnFocus.current = context.target;
    const id = readAnchor(context.target)?.card ?? selected ?? undefined;
    setOverlay({ kind, context, card: id, revision: id ? state.cards[id]?.revision : undefined });
  };
  const onAction = (id: string, context: ActionContext): boolean => {
    const anchor = readAnchor(context.target) ?? focus.current.anchor ?? (groups[0] ? { column: groups[0].id, card: groups[0].cards[0] } : undefined);
    const cardId = context.scope === "board" ? anchor?.card : selected ?? undefined;
    if (id === "cancel") {
      if (hints.length) { setHints([]); setHintPrefix(""); }
      else if (overlay) closeOverlay();
      else if (newColumn) cancelColumn();
      else if (context.scope === "composer") focusDetail(false);
      else if (selected && page === "board") close();
      else if (page !== "board") { setPage("board"); requestAnimationFrame(() => anchor && focusElement(anchorElement(anchor))); }
      else return false;
      return true;
    }
    if (id.startsWith("board.") && id !== "board.open" && anchor) { focusElement(anchorElement(navigate(groups, anchor, id, remembered))); return true; }
    if (id.startsWith("thread.")) {
      const el = document.querySelector<HTMLElement>("[data-key-scope=thread]"); if (!el) return false;
      const by = id === "thread.up" ? -60 : id === "thread.down" ? 60 : id === "thread.pageUp" ? -el.clientHeight : el.clientHeight;
      el.scrollTop = id === "thread.first" ? 0 : id === "thread.last" ? el.scrollHeight : el.scrollTop + by; return true;
    }
    if ((id === "board.open" || id === "reply") && cardId) { open(cardId); focusDetail(id === "reply"); return true; }
    if (id === "move" && cardId && connected) { showOverlay("move", context); return true; }
    if (id === "search" || id === "settings") { setPage(id === "search" ? "history" : "settings"); requestAnimationFrame(() => focusElement(id === "search" ? "[aria-label='Search history']" : "[data-settings-heading]")); return true; }
    if (id === "palette" || id === "help") { showOverlay(id, context); return true; }
    if (id === "hints") {
      const targets = visibleTargets(), labels = hintLabels(targets.length); setHints(targets.map((t, i) => ({ ...t, label: labels[i] }))); setHintPrefix(""); return true;
    }
    return false;
  };
  const leaveField = () => {
    const anchor = focus.current.anchor ?? (groups[0] ? { column: groups[0].id, card: groups[0].cards[0] } : undefined);
    if (page === "board" && anchor) focusElement(anchorElement(restoreAnchor(groups, previous.current, anchor)));
  };
  const hintKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.getModifierState("AltGraph") || event.repeat) return false;
    if (event.key === "Tab") { setHints([]); setHintPrefix(""); return false; }
    if (event.key === "Backspace") { setHintPrefix(p => p.slice(0, -1)); return true; }
    if (event.key.length !== 1) return false;
    const prefix = hintPrefix + event.key.toLowerCase(), matching = hints.filter(h => h.label.startsWith(prefix));
    if (!matching.length) { setHintPrefix(""); notify("No target matches. Type a visible hint label."); return true; }
    const exact = matching.find(h => h.label === prefix);
    if (exact) { setHints([]); setHintPrefix(""); if (exact.element.isConnected) { exact.element.focus(); if (exact.element.matches("button,a")) exact.element.click(); } }
    else setHintPrefix(prefix);
    return true;
  };
  const move = (to: string) => {
    if (!overlay?.card) return;
    const { card, revision } = overlay;
    closeOverlay();
    void command("move", [card, ...(to === "auto" ? ["--auto"] : [to]), "--if-revision", String(revision), "--event-id", crypto.randomUUID()]).then(() => notify("Placement updated. Source requests are unchanged.")).catch(e => notify(e.message));
  };
  return { remembered, onAction, leaveField, hintKey, hints, hintPrefix, overlay, closeOverlay, move };
}

export function KeyboardToolbar({ action }: { action(id: string, context: ActionContext): boolean }) {
  const { label } = useKeyboard();
  return <div className="keyboard-toolbar"><Button onClick={e => action("palette", { scope: "navigation", target: e.currentTarget })}>Commands <kbd>{label("palette")}</kbd></Button><Button onClick={e => action("help", { scope: "navigation", target: e.currentTarget })}>Help <kbd>{label("help")}</kbd></Button><Button onClick={e => action("hints", { scope: "navigation", target: e.currentTarget })}>Hints <kbd>{label("hints")}</kbd></Button></div>;
}
export function KeyboardFooter() {
  const { label } = useKeyboard();
  return <span>{label("board.down")} next · {label("board.open")} open · {label("reply")} reply</span>;
}
export function KeyboardLayers({ keyboard, state, connected }: { keyboard: ReturnType<typeof useBoardKeyboard>; state: BoardState; connected: boolean }) {
  const { label, prefs } = useKeyboard(), { overlay, closeOverlay, onAction, move, hints, hintPrefix } = keyboard;
  let items: MenuItem[] = [];
  if (overlay) {
    const card = overlay.card ? state.cards[overlay.card] : undefined;
    items = overlay.kind === "move" ? [{ id: "auto", title: "Return to auto" }, ...columnsFor(state)].map(c => ({ id: c.id, label: c.title, detail: c.id === "auto" ? "Follow source facts" : "Manual placement", disabled: !connected || !card, run: () => move(c.id) })) : KEY_ACTIONS.filter(a => overlay.kind === "help" || !["cancel", "send", "palette"].includes(a.id)).map(a => ({ id: a.id, label: a.label, keyLabel: label(a.id), detail: `${a.scopes.join(" · ")}${!prefs.characterShortcuts ? " · character keys disabled" : ""}`, disabled: ["cancel", "send", "palette"].includes(a.id) || (a.id.startsWith("board.") && overlay.context.scope !== "board") || (a.id.startsWith("thread.") && overlay.context.scope !== "thread") || (["move", "reply"].includes(a.id) && (!card || (a.id === "move" && !connected))), run: () => {
      setTimeout(() => onAction(a.id, overlay.context), 0); closeOverlay();
    } }));
    if (overlay.kind === "palette") items = items.filter(item => !item.disabled);
  }
  return <>{overlay && <CommandMenu title={overlay.kind === "move" ? "Move card" : overlay.kind === "help" ? "Keyboard help" : "Commands"} description={overlay.kind === "move" ? "Placement does not complete work or resolve a source request." : "Shortcuts follow the focused area. Edit every binding in Settings."} items={items} close={closeOverlay} />}{hints.length > 0 && <div className="hint-layer" aria-label="Target hints">{hints.filter(h => h.label.startsWith(hintPrefix)).map(h => <span className="target-hint" key={h.label} style={{ left: h.x, top: h.y }}>{h.label}</span>)}<div className="hint-instructions" role="status">{hints.length} targets · Type a label · {label("cancel")} cancel · Backspace correct</div></div>}</>;
}
