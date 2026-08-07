import { useState } from "react";
import { MOON_SURVIVAL } from "@gdm/shared";

interface Props {
  /** Called when the participant confirms and presses "Join chat". */
  onJoin: () => void;
}

/** Page 4 — Group phase instructions. */
export default function GroupIntroPage({ onJoin }: Props) {
  const [ready, setReady] = useState(false);

  return (
    <div className="study-card">
      <h1>Next: Discuss and decide as a group</h1>
      <p>
        You will now join a chat room with the other participants in your
        session. Together, your group will discuss the same{" "}
        {MOON_SURVIVAL.items.length} items and agree on one shared team ranking.
      </p>
      <ul>
        <li>
          Reach your decisions by consensus: the group ranking should reflect
          an agreement all members can support, not a simple vote or averaging
          of individual answers.
        </li>
        <li>
          Everyone's perspective matters; explain your reasoning to each other.
        </li>
        <li>
          A study assistant (bot) is present in the chat room to support the
          session organizationally.
        </li>
        <li>
          The discussion timer is shown in the chat. The team ranking is
          submitted through the shared ranking panel.
        </li>
        <li>
          Please keep the discussion within the chat room and do not use
          external resources.
        </li>
      </ul>

      <label className="consent-check">
        <input
          type="checkbox"
          checked={ready}
          onChange={(e) => setReady(e.target.checked)}
        />
        <span>
          I understand the instructions and am ready to join the group
          discussion.
        </span>
      </label>

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ready}
          onClick={onJoin}
        >
          Join chat
        </button>
      </div>
    </div>
  );
}
