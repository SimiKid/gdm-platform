import { useState } from "react";

interface Props {
  /** Called when the participant confirms and presses "Join chat". */
  onJoin: () => void;
}

/** Page before the group chat — instructions and acknowledgment. */
export default function GroupIntroPage({ onJoin }: Props) {
  const [ready, setReady] = useState(false);

  return (
    <div className="study-card">
      <h1>You are now ready to join the group discussion!</h1>

      <p>
        Your group, consisting of <strong>five participants</strong>, will be{" "}
        <strong>randomly assigned</strong>. All of you will participate{" "}
        <strong>fully anonymously</strong> — please refrain from sharing any
        private information.
      </p>

      <p>
        Together with your four team members,{" "}
        <strong>
          your goal is to reach consensus over the NASA task you previously did
          by yourself.
        </strong>
      </p>

      <p>
        A chatbot will be present in the chat. It will, however, not take an
        active role in the decision-making process of the group. It will rather
        take an organizational role.
      </p>

      <p>
        You have <strong>12 minutes for the task</strong> — a timer will provide
        orientation; there will also be notifications during this time.
      </p>

      <p>
        Please focus on discussions with your team members and do not use
        external resources for the decision at hand.
      </p>

      <label className="consent-check">
        <input
          type="checkbox"
          checked={ready}
          onChange={(e) => setReady(e.target.checked)}
        />
        <span>
          I understand and accept the instructions and am ready to join the
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
