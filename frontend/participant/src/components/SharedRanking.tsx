import { useEffect, useMemo, useRef, useState } from "react";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import type { Ranking, RankingTask } from "@gdm/shared";
import { buildIdentities, identityFor } from "../study/identity";

const RANKING_EVENT = MATRIX_EVENT_TYPES.ranking; // "de.gdm.ranking"

interface Props {
  client: MatrixClient;
  roomId: string;
  task: RankingTask;
  initial: Ranking;
}

/**
 * The group's shared ranking (same task as the individual survey).
 *
 * Every participant edits the same ordered list. Edits are broadcast as custom
 * `de.gdm.ranking` timeline events (regular members can send these — no power
 * level needed), and incoming events replace the local order (last-write-wins).
 */
export default function SharedRanking({ client, roomId, task, initial }: Props) {
  const [order, setOrder] = useState<string[]>(initial.order);
  const [activity, setActivity] = useState<{
    text: string;
    itemId: string;
  } | null>(null);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userId = client.getUserId() ?? "";
  const labels = useMemo(
    () => new Map(task.items.map((i) => [i.id, i.label])),
    [task.items],
  );

  useEffect(() => {
    const room = client.getRoom(roomId);
    if (!room) return;
    const activeRoom = room;

    // Seed from the most recent ranking event already in the timeline.
    const events = room.getLiveTimeline().getEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].getType() === RANKING_EVENT) {
        const content = events[i].getContent() as Ranking;
        if (Array.isArray(content.order)) setOrder(content.order);
        break;
      }
    }

    function onTimeline(event: MatrixEvent) {
      if (event.getRoomId() !== roomId) return;
      if (event.getType() !== RANKING_EVENT) return;
      const content = event.getContent() as Ranking;
      if (Array.isArray(content.order)) {
        setOrder(content.order);
        if (content.movement && content.updatedBy !== userId) {
          const members = activeRoom.getJoinedMembers().map((member) => member.userId);
          const identity = identityFor(buildIdentities(members), content.updatedBy);
          const item = labels.get(content.movement.itemId) ?? content.movement.itemId;
          setActivity({
            text: `${identity.name} moved ${item} from #${content.movement.from + 1} to #${content.movement.to + 1}`,
            itemId: content.movement.itemId,
          });
          if (activityTimer.current) clearTimeout(activityTimer.current);
          activityTimer.current = setTimeout(() => setActivity(null), 3000);
        }
      }
    }
    client.on(RoomEvent.Timeline, onTimeline);
    return () => {
      client.off(RoomEvent.Timeline, onTimeline);
      if (activityTimer.current) clearTimeout(activityTimer.current);
    };
  }, [client, labels, roomId, userId]);

  function broadcast(next: string[], movement: Ranking["movement"]) {
    setOrder(next); // optimistic
    const ranking: Ranking = {
      taskId: task.id,
      order: next,
      updatedAt: new Date().toISOString(),
      updatedBy: userId,
      movement,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void client.sendEvent(roomId, RANKING_EVENT as any, ranking as any);
  }

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[index], next[j]] = [next[j], next[index]];
    broadcast(next, { itemId: order[index], from: index, to: j });
  }

  return (
    <div className="ranking">
      <h3>{task.title}</h3>
      <div className="ranking-activity" aria-live="polite">
        {activity?.text ?? "\u00a0"}
      </div>
      <ol className="ranking-list">
        {order.map((id, idx) => (
          <li
            key={id}
            className={`ranking-item ${activity?.itemId === id ? "remote-move" : ""}`}
          >
            <span className="rank-num">{idx + 1}</span>
            <span className="rank-label">{labels.get(id) ?? id}</span>
            <span className="rank-actions">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === order.length - 1}
                aria-label="Move down"
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
