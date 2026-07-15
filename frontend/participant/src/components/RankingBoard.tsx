import { useState } from "react";
import type { DragEvent } from "react";

interface Item {
  id: string;
  label: string;
}

interface Props {
  /** All rankable items; the unranked pool is derived from `ranked`. */
  items: Item[];
  /** Current ranking, most to least important (grows as items are placed). */
  ranked: string[];
  onChange: (ranked: string[]) => void;
  /**
   * When true the pool section appears below the ranked list instead of above,
   * and is hidden entirely while empty. Use in the exit survey where the ranking
   * starts pre-filled so the "0 left" message doesn't appear at the top.
   */
  poolBelow?: boolean;
}

/**
 * The ranking widget shared by the individual task (page 3) and the exit
 * survey: items start in an unranked pool and are dragged — or, as the
 * keyboard-accessible alternative, moved with the Add / up / down / remove
 * buttons — into a numbered ranking.
 */
export default function RankingBoard({ items, ranked, onChange, poolBelow }: Props) {
  const labels = new Map(items.map((i) => [i.id, i.label]));
  const pool = items.map((i) => i.id).filter((id) => !ranked.includes(id));

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function placeInRanking(id: string, index: number | null) {
    // Anchor on the item we drop before, not its index: removing the dragged
    // item first shifts indices, which landed downward drags one slot low.
    const anchor = index === null ? null : ranked[index];
    if (anchor === id) return;
    const without = ranked.filter((x) => x !== id);
    const at = anchor === null ? without.length : without.indexOf(anchor);
    without.splice(at < 0 ? without.length : at, 0, id);
    onChange(without);
  }

  function returnToPool(id: string) {
    onChange(ranked.filter((x) => x !== id));
  }

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= ranked.length) return;
    const next = ranked.slice();
    [next[index], next[j]] = [next[j], next[index]];
    onChange(next);
  }

  function onDragStart(e: DragEvent, id: string) {
    setDragId(id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragEnd() {
    setDragId(null);
    setDropIndex(null);
  }

  function onRankingDrop(e: DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    if (id) placeInRanking(id, dropIndex);
    onDragEnd();
  }

  function onPoolDrop(e: DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    if (id) returnToPool(id);
    onDragEnd();
  }

  const poolSection = (!poolBelow || pool.length > 0) && (
    <section
      className="rank-pool"
      aria-label="Items still to rank"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onPoolDrop}
    >
      <h2>
        Items to rank <span className="count">({pool.length} left)</span>
      </h2>
      {pool.length === 0 ? (
        <p className="rank-pool-empty">All items ranked &#10003;</p>
      ) : (
        <ul className="rank-pool-list">
          {pool.map((id) => (
            <li
              key={id}
              className={`rank-pool-item ${dragId === id ? "dragging" : ""}`}
              draggable
              onDragStart={(e) => onDragStart(e, id)}
              onDragEnd={onDragEnd}
            >
              <span className="rank-label">{labels.get(id) ?? id}</span>
              <button
                type="button"
                className="rank-add"
                onClick={() => placeInRanking(id, null)}
                aria-label={`Add ${labels.get(id)} to the ranking`}
              >
                Add &#8595;
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const rankingSection = (
    <section
      className="rank-target"
      aria-label="Your ranking, most to least important"
      onDragOver={(e) => {
        e.preventDefault();
        setDropIndex(null);
      }}
      onDrop={onRankingDrop}
    >
      <h2>Your ranking</h2>
      {ranked.length === 0 && (
        <p className="rank-drop-hint">
          Drag items here, or use the &quot;Add&quot; buttons. 1 = most important.
        </p>
      )}
      <ol className="ranking-list">
        {ranked.map((id, idx) => (
          <li
            key={id}
            className={`ranking-item ${dragId === id ? "dragging" : ""} ${
              dropIndex === idx && dragId !== id ? "drop-before" : ""
            }`}
            draggable
            onDragStart={(e) => onDragStart(e, id)}
            onDragEnd={onDragEnd}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropIndex(idx);
            }}
            onDrop={onRankingDrop}
          >
            <span className="rank-num">{idx + 1}</span>
            <span className="rank-label">{labels.get(id) ?? id}</span>
            <span className="rank-actions">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                aria-label={`Move ${labels.get(id)} up`}
              >
                &#8593;
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === ranked.length - 1}
                aria-label={`Move ${labels.get(id)} down`}
              >
                &#8595;
              </button>
              <button
                type="button"
                onClick={() => returnToPool(id)}
                aria-label={`Remove ${labels.get(id)} from the ranking`}
              >
                &#10005;
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );

  return (
    <div className="rank-columns">
      {poolBelow ? (
        <>
          {rankingSection}
          {poolSection}
        </>
      ) : (
        <>
          {poolSection}
          {rankingSection}
        </>
      )}
    </div>
  );
}
