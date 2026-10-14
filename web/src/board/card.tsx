import { useState } from "react";
import type { Card as CardData, Link, ViewPreferences } from "../../../src/core/model.ts";
import { Button } from "../components/ui/controls.tsx";
import { Icon } from "../components/ui/icon.tsx";
import { Resize } from "../components/ui/resize.tsx";
import { receiptLabel, safeLink, visibleParent } from "./view.ts";
export function Links({ links }: { links: Link[] }) {
  return <div className="links">{links.map(l => { const href = safeLink(l); return href && <a key={l.url} href={href} target="_blank" rel="noreferrer" title={`${l.title ?? l.url} · opens in new tab`}><Icon name={l.kind} />{l.kind === "github_pr" ? `#${l.number ?? "PR"}` : l.title ?? new URL(href).hostname}</a>; })}</div>;
}
export function Tags({ tags }: { tags: string[] }) { return <div className="tags">{tags.map(t => <span key={t} className={`tag tone-${[...t].reduce((n,c) => n + c.charCodeAt(0), 0) % 4}`}>{t}</span>)}</div>; }
export function BoardCard({ card, visible, selected, view, open, save, tabIndex }: { card: CardData; visible: CardData[]; selected: boolean; view: ViewPreferences; open(id: string): void; save(patch: unknown): Promise<boolean>; tabIndex: number }) {
  const [height, setHeight] = useState<number | null>(null), parent = visibleParent(card, visible);
  return <article className={`card ${selected ? "selected" : ""} ${view.cardColors ? `accent-${card.column}` : ""}`} style={{ height: height ?? view.cardHeights[card.id] ?? view.cardHeight }}>
    <div className="row between"><span className="workspace">{card.workspace}</span><span className="source">{card.agent?.provider ?? card.sourceRefs[0]?.adapter ?? "Manual"}</span></div>
    <div className="card-content"><Button className="card-open" onClick={() => open(card.id)} data-card={card.id} data-key-scope="board" tabIndex={tabIndex}><h3>{card.title}</h3></Button>
      {parent && <Button className="parent" onClick={() => open(parent.id)}><Icon name="parent" size={13} />{parent.title}</Button>}
      {!parent && card.parentId && <span className="muted small">Child task</span>}
      {card.attention.slice(0, 1).map(a => <div key={a.key} className="request">{a.text ?? a.kind}</div>)}
      <Tags tags={card.tags} /><Links links={card.links} />
      {visible.some(c => c.parentId === card.id) && <span className="muted small">{visible.filter(c => c.parentId === card.id).length} child tasks</span>}
    </div>
    <div className="card-footer"><span><Icon name={card.column} size={13} />{card.activity ?? (card.outcome ? card.outcome.state : "Activity unknown")}</span>{card.manualColumn ? <span title="Manual placement"><Icon name="pin" size={13} />Pinned</span> : <span>{card.replies?.at(-1) ? receiptLabel(card.replies.at(-1)!.state) : "Automatic"}</span>}</div>
    <Resize label={`Resize card ${card.title}`} axis="y" value={view.cardHeights[card.id] ?? view.cardHeight} min={200} max={600} onPreview={setHeight} onCommit={n => save({ cardHeights: { [card.id]: n } })} />
  </article>;
}
