import { useState } from "react";
import type { StudyTaskMode } from "@gdm/shared";

interface Props {
  /** Called when the participant confirms and presses "Join chat". */
  onJoin: () => void;
  taskMode?: StudyTaskMode;
  /** Participants per group; null (unknown) keeps the wording number-free. */
  groupSize?: number | null;
  /** Discussion length in minutes; null (unknown) refers to the timer. */
  durationMinutes?: number | null;
}

/** Page before the group chat — instructions and acknowledgment. */
export default function GroupIntroPage({
  onJoin,
  taskMode = "ranking",
  groupSize = null,
  durationMinutes = null,
}: Props) {
  const [ready, setReady] = useState(false);
  const teammates = groupSize === null ? null : groupSize - 1;

  return (
    <div className="study-card">
      <h1>Briefing Group Task</h1>
      <p>
        <strong>You are now ready to join the group discussion!</strong>
      </p>
      {taskMode === "etherpad" && (
        <p>
          Discuss the task in the chat and record your group's response in the
          shared writing workspace. You will write a separate, private final
          response after the discussion.
        </p>
      )}

      <p>
        {groupSize === null
          ? "Your group"
          : `Your group of ${groupSize} participants`}{" "}
        will be randomly assembled. Together with your{" "}
        {teammates === null
          ? "team members"
          : `${teammates} team ${teammates === 1 ? "member" : "members"}`}
        , your goal is to reach consensus on the NASA task you previously
        completed individually.{" "}
        <strong>
          You have{" "}
          {durationMinutes === null
            ? "the time shown by the timer"
            : `${durationMinutes} minutes`}{" "}
          to complete the task.
        </strong>{" "}
        A timer and
        notifications will help you stay on track. Depending on the study group
        you are randomly assigned to, an AI assistant may be present in the
        chat. It will not actively participate in the decision-making process.
      </p>

      <p>
        <strong>Please follow these rules during the chat:</strong>
      </p>
      <ul>
        <li>Focus your discussion on the task. Do not use external resources.</li>
        <li>
          The group chat will be fully pseudonymized. However, do not share any
          personal or identifying information during the task.
        </li>
        <li>
          Do not post offensive, discriminatory, or inappropriate content.
          Participants who violate this rule may be removed from the study.
        </li>
      </ul>

      <label className="consent-check">
        <input
          type="checkbox"
          checked={ready}
          onChange={(e) => setReady(e.target.checked)}
        />
        <span>
          I have read and understood the instructions and am ready to join the
          group.
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
