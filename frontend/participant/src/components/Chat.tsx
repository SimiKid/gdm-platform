import { useEffect, useId, useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import {
  buildIdentities,
  formatMmSs,
  identityFor,
  isServiceUser,
  protectedEndMs,
} from "@gdm/shared";
import type { PublicSession } from "@gdm/shared";
import SharedRanking from "./SharedRanking";
import ExternalWorkspace from "./ExternalWorkspace";
import EtherpadTask from "./EtherpadTask";
import MessageItem from "./chat/MessageItem";
import { useActiveRoom } from "../hooks/useActiveRoom";
import { useBehaviorTelemetry } from "../hooks/useBehaviorTelemetry";
import { useComposer } from "../hooks/useComposer";
import { useDiscussionCountdown } from "../hooks/useDiscussionCountdown";
import { useFollowLatest } from "../hooks/useFollowLatest";
import { usePanelWidth } from "../hooks/usePanelWidth";
import { useRoomMessages } from "../hooks/useRoomMessages";
import { useTypingMembers } from "../hooks/useTypingMembers";

interface Props {
  client: MatrixClient;
  /** The study session (briefing, ranking, timer). Null on the dev fast-path. */
  session: PublicSession | null;
  /** Fired once when the discussion timer reaches zero, with the final group ranking order. */
  onTimeUp?: (groupOrder: string[]) => void;
  onWithdraw?: () => void;
}

export default function Chat({ client, session, onTimeUp, onWithdraw }: Props) {
  const activeRoomId = useActiveRoom(client, session?.roomId);
  const [groupOrder, setGroupOrder] = useState<string[]>(session?.ranking.order ?? []);
  const workspaceMode =
    session?.condition.config.workspaceMode === "etherpad"
      ? "etherpad"
      : session?.condition.config.workspaceMode === "external"
        ? "external"
        : "ranking";
  const userId = client.getUserId() ?? "";
  const messages = useRoomMessages(client, activeRoomId, userId);
  const typingMembers = useTypingMembers(client, activeRoomId, userId);
  const sendBehavior = useBehaviorTelemetry(client, activeRoomId);
  const { viewportRef, endRef, newMessageCount, scrollToLatest, trackScroll } =
    useFollowLatest(messages, activeRoomId);
  const { panelWidth, startPanelResize, resizeBy } = usePanelWidth();
  const remaining = useDiscussionCountdown(
    session?.startedAt,
    session?.durationMinutes,
  );

  // Fire onTimeUp exactly once when the discussion timer hits zero.
  const endedRef = useRef(false);
  const groupOrderRef = useRef(groupOrder);
  useEffect(() => { groupOrderRef.current = groupOrder; }, [groupOrder]);
  useEffect(() => {
    if (remaining === 0 && !endedRef.current) {
      endedRef.current = true;
      onTimeUp?.(groupOrderRef.current);
    }
  }, [remaining, onTimeUp]);

  const room = activeRoomId ? client.getRoom(activeRoomId) : null;
  // Keep the study condition blinded during the discussion.
  const title = session ? "Group discussion" : room?.name ?? "Group Chat";
  // Turn the timer red and show "wrap up!" exactly when the bot stops nudging:
  // the wrap-up window is the condition's protected-end period (config-driven).
  const wrapUpMs = session ? protectedEndMs(session.condition.config) : 0;
  const timerLow = remaining !== null && remaining <= wrapUpMs;

  const participantMemberIds =
    room
      ?.getJoinedMembers()
      .map((member) => member.userId)
      .filter((id) => !isServiceUser(id)) ?? [];
  const identities = buildIdentities(participantMemberIds);
  const me = identityFor(identities, userId);
  const groupReady =
    session === null ||
    (room !== null &&
      participantMemberIds.includes(userId) &&
      participantMemberIds.length >= session.condition.groupSize);

  // Every participant name in this room, used to highlight mentions on render.
  const mentionNames = [...identities.values()].map((id) => id.name);

  const composer = useComposer({
    client,
    roomId: activeRoomId,
    userId,
    identities,
    sendBehavior,
  });
  const mentionListId = useId();
  const mentionOptionId = (index: number) => `${mentionListId}-option-${index}`;

  return (
    <div className="study-layout">
      {/* ── Chat column ─────────────────────────────── */}
      <main className="chat-main">
        <div className="chat-header">
          <h2>{title}</h2>
          {onWithdraw && (
            <button type="button" className="btn-link" onClick={onWithdraw}>
              Withdraw
            </button>
          )}
          {groupReady && (
            <span className="chat-user">
              <span className="user-dot" style={{ background: me.color }} />
              You are writing as {me.name}
            </span>
          )}
        </div>
        {activeRoomId && groupReady ? (
          <>
            <div className="messages-shell">
              <div
                className="messages"
                ref={viewportRef}
                onScroll={trackScroll}
              >
                {session && (
                  <div className="entry-message">
                    Welcome to the group discussion! You are in a session with{" "}
                    {session.participants.length - 1} other{" "}
                    {session.participants.length - 1 === 1 ? "person" : "people"}.
                    {workspaceMode === "etherpad"
                      ? "Discuss the task and write your group's response in the shared workspace on the right."
                      : "Discuss the task and adjust the shared ranking on the right."}
                    <br />
                    <span className="entry-hint">
                      Tip: Use <strong>@</strong> to address people directly.
                    </span>
                  </div>
                )}
                {messages.map((msg) => (
                  <MessageItem
                    key={msg.id}
                    message={msg}
                    identities={identities}
                    mentionNames={mentionNames}
                  />
                ))}
                <div ref={endRef} />
              </div>
              {newMessageCount > 0 && (
                <button
                  type="button"
                  className="new-messages"
                  onClick={() => scrollToLatest()}
                >
                  {newMessageCount} new{" "}
                  {newMessageCount === 1 ? "message" : "messages"} ↓
                </button>
              )}
            </div>
            {composer.sendError && (
              <p className="error" role="alert">
                Message not sent. Please try again.
              </p>
            )}
            <div className="typing-indicator" aria-live="polite">
              {typingMembers.length > 0
                ? `${typingMembers.join(", ")} ${typingMembers.length === 1 ? "is" : "are"} typing...`
                : " "}
            </div>
            <div className="message-input">
              {composer.mentionOpen && (
                <ul
                  id={mentionListId}
                  className="mention-menu"
                  role="listbox"
                  aria-label="Mention a participant"
                >
                  {composer.mentionCandidates.map((ident, i) => (
                    <li
                      key={ident.name}
                      id={mentionOptionId(i)}
                      role="option"
                      aria-selected={i === composer.mentionIndex}
                      className={`mention-item ${i === composer.mentionIndex ? "active" : ""}`}
                      // mousedown, not click: keep focus on the input so the
                      // caret restore works and the field never blurs.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        composer.selectMention(ident.name);
                      }}
                      onMouseEnter={() => composer.setMentionIndex(i)}
                    >
                      <span
                        className="mention-dot"
                        style={{ background: ident.color }}
                      />
                      <span style={{ color: ident.color }}>{ident.name}</span>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                ref={composer.inputRef}
                aria-label="Message"
                aria-autocomplete="list"
                aria-controls={composer.mentionOpen ? mentionListId : undefined}
                aria-activedescendant={
                  composer.mentionOpen
                    ? mentionOptionId(composer.mentionIndex)
                    : undefined
                }
                placeholder="Type a message"
                value={composer.input}
                onChange={(e) =>
                  composer.updateInput(
                    e.target.value,
                    e.target.selectionStart ?? undefined,
                  )
                }
                onKeyDown={composer.onInputKeyDown}
                onPaste={(e) => e.preventDefault()}
                rows={2}
                autoFocus
              />
              <button onClick={() => void composer.sendMessage()} aria-label="Send">
                ➤
              </button>
            </div>
          </>
        ) : (
          <div className="no-room">
            {activeRoomId ? "Loading group..." : "Connecting to the group room..."}
          </div>
        )}
      </main>

      {/* ── Study side panel (resizable) ────────────── */}
      {session && (
        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize task panel"
          tabIndex={0}
          onPointerDown={startPanelResize}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              resizeBy(24);
            }
            if (e.key === "ArrowRight") {
              e.preventDefault();
              resizeBy(-24);
            }
          }}
        />
      )}
      {session && (
        <aside
          className="panel-col"
          style={{ width: panelWidth, minWidth: panelWidth }}
        >
          {remaining !== null && (
            <div className={`timer ${timerLow ? "low" : ""}`}>
              {remaining === 0
                ? "Time is up"
                : `${formatMmSs(Math.floor(remaining / 1000))} left${timerLow ? ", wrap up!" : ""}`}
            </div>
          )}
          <section className="briefing">
            <h3>{session.briefing.title}</h3>
            <div
              className="briefing-body"
              // Trusted, server-authored briefing HTML.
              dangerouslySetInnerHTML={{ __html: session.briefing.html }}
            />
          </section>
          {workspaceMode === "ranking" && activeRoomId && (
            <SharedRanking
              client={client}
              roomId={activeRoomId}
              task={session.rankingTask}
              initial={session.ranking}
              onChange={setGroupOrder}
            />
          )}
          {workspaceMode === "external" && (
            <ExternalWorkspace
              config={session.condition.config.externalWorkspace}
            />
          )}
          {workspaceMode === "etherpad" && (
            <EtherpadTask phase="group" sessionId={session.id} />
          )}
        </aside>
      )}
    </div>
  );
}
