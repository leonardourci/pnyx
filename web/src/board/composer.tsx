import { useEffect, useRef, useState } from "react";
import type { ThreadPage } from "../../../src/thread/read.ts";
import type { Catalog } from "../../../src/thread/catalog.ts";
import { Button, Textarea } from "../components/ui/controls.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { Resize } from "../components/ui/resize.tsx";
import { slashMatches, slashPrefix } from "./view.ts";
import type { Command } from "./connection.ts";
import { useKeyAction, useKeyboard } from "../keyboard/registry.tsx";
export function Composer({ card, title, draft, setDraft, thread, height, command, save, connected, notify }: { card: string; title: string; draft: string; setDraft(text: string): void; thread: ThreadPage | null; height: number; command: Command; save(patch: unknown): Promise<boolean>; connected: boolean; notify(text: string): void }) {
  const [preview, setPreview] = useState<number | null>(null), [sending, setSending] = useState(false), [prefix, setPrefix] = useState<string | null>(null), [active, setActive] = useState(-1);
  const input = useRef<HTMLTextAreaElement>(null), attempt = useRef<{ text: string; id: string } | null>(null), currentDraft = useRef(draft); currentDraft.current = draft;
  const { label } = useKeyboard(), [catalog, setCatalog] = useState<Catalog | null>(null);
  const suggestions = (catalog?.suggestions ?? []).filter(s => slashMatches(s.command, prefix ?? ""));
  const catalogOpen = prefix !== null;
  useEffect(() => {
    if (!catalogOpen || !connected) return;
    let cancelled = false; setCatalog(null);
    const timer = setTimeout(() => { void command("catalog", [card]).then(r => { if (!cancelled) setCatalog(r.catalog as Catalog); }).catch(() => { if (!cancelled) setCatalog({ suggestions: [], unavailable: "Catalog unavailable. Your command stays literal." }); }); }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [card, catalogOpen, command, connected]);
  useEffect(() => { document.getElementById(`suggestion-${card}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [card, active]);
  const choose = (command: string) => { const cursor = input.current?.selectionStart ?? draft.length; setDraft(command + " " + draft.slice(cursor)); setPrefix(null); setActive(-1); input.current?.focus(); requestAnimationFrame(() => input.current?.setSelectionRange(command.length + 1, command.length + 1)); };
  const send = async () => {
    if (sending || !draft.trim() || !connected || !thread?.route) return;
    if (attempt.current?.text !== draft) attempt.current = { text: draft, id: crypto.randomUUID() };
    setSending(true);
    try { const r = await command("reply", [card, draft, attempt.current.id]); const receipt = r.reply as { state: string } | undefined;
      notify(receipt?.state === "delivery_unknown" ? "Delivery unknown. Check the native session before sending again." : receipt?.state === "failed" ? "Delivery failed. Your draft is retained." : "Reply delivered to the route. This does not confirm it was handled.");
      if (receipt?.state === "delivered" && currentDraft.current === draft) { setDraft(""); attempt.current = null; }
    } catch (e) { notify((e as Error).message); } finally { setSending(false); }
  };
  useKeyAction("send", ({ scope }) => { if (scope !== "composer") return false; void send(); return true; });
  useKeyAction("cancel", ({ scope }) => { if (scope !== "composer" || prefix === null) return false; setPrefix(null); setActive(-1); return true; });
  return <form className="composer" style={{ height: preview ?? height }} onSubmit={e => { e.preventDefault(); void send(); }}>
    <Resize label="Resize composer" axis="y" reverse value={height} min={140} max={420} onPreview={setPreview} onCommit={n => save({ composerHeight: n })} />
    <label htmlFor={`reply-${card}`} className="small muted">Reply to {title}</label>
    <div className="composer-input">
      {prefix !== null && <div className="slash-menu"><span className="eyebrow">Session commands</span><div id={`suggestions-${card}`} role="listbox" aria-label="Session commands">{suggestions.map((s,n) => <Button role="option" aria-selected={n === active} id={`suggestion-${card}-${n}`} key={s.command} className={n === active ? "active" : ""} onMouseDown={e => e.preventDefault()} onClick={() => choose(s.command)}><strong>{s.command}</strong><span>{s.description}<small>{s.source}</small></span></Button>)}</div>{!suggestions.length && <p role="status">{!connected ? "Reconnect to load commands." : !catalog ? "Loading local commands…" : catalog.unavailable ?? "No matching local command."}</p>}{catalog?.note && <p>{catalog.note}</p>}</div>}
      <Textarea ref={input} data-key-scope="composer" id={`reply-${card}`} value={draft} placeholder="Write a reply, or type / for commands…" aria-describedby={`reply-note-${card}`} aria-controls={catalogOpen ? `suggestions-${card}` : undefined} aria-activedescendant={active >= 0 && suggestions[active] ? `suggestion-${card}-${active}` : undefined} onChange={e => { setDraft(e.target.value); setPrefix(slashPrefix(e.target.value, e.target.selectionStart)); setActive(-1); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.key === "Process") return;
          if (e.key === "Tab") { setPrefix(null); setActive(-1); }
          if (prefix !== null && suggestions.length && ["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); setActive(n => Math.max(0, Math.min(suggestions.length - 1, n + (e.key === "ArrowDown" ? 1 : -1)))); return; }
          if (prefix !== null && active >= 0 && e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); choose(suggestions[active].command); return; }
        }} />
    </div>
    <div className="row between"><span className="small muted">Enter newline · {label("send")} send · {label("cancel")} leave</span><Button type="submit" variant="primary" disabled={sending || !draft.trim() || !connected || !thread?.route}>{sending ? "Sending…" : "Send reply"}<Icon name="send" size={14} /></Button></div>
    <p id={`reply-note-${card}`} className="small muted">{thread?.route ? "Queued, delivered and handled are separate facts." : "Reply route unavailable. Your draft stays here."}</p>
  </form>;
}
