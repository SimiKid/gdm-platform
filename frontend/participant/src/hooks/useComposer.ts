import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { Identity } from "@gdm/shared";
import { detectMention } from "../study/mentions";
import type { SendBehavior } from "./useBehaviorTelemetry";

const TYPING_SERVER_TIMEOUT_MS = 4000;
const TYPING_RENEW_INTERVAL_MS = 3000;
const TYPING_IDLE_TIMEOUT_MS = 1800;

interface Options {
  client: MatrixClient;
  roomId: string | null;
  userId: string;
  /** Pseudonyms of everyone in the room, offered in the "@" picker. */
  identities: Map<string, Identity>;
  sendBehavior: SendBehavior;
}

/**
 * The message input: text, sending, Matrix typing notifications (with matching
 * research telemetry) and the "@" mention picker.
 */
export function useComposer({
  client,
  roomId,
  userId,
  identities,
  sendBehavior,
}: Options) {
  const [input, setInput] = useState("");
  // In-progress "@" mention: { start, query } while the picker is open, else null.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sendError, setSendError] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Caret position to restore after we programmatically rewrite the input value.
  const desiredCaret = useRef<number | null>(null);
  const typingStartedAt = useRef<number | null>(null);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingRenewInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
      if (typingRenewInterval.current) clearInterval(typingRenewInterval.current);
    },
    [],
  );

  function stopTyping() {
    if (!roomId || typingStartedAt.current === null) return;
    const durationMs = Date.now() - typingStartedAt.current;
    typingStartedAt.current = null;
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    typingStopTimer.current = null;
    if (typingRenewInterval.current) clearInterval(typingRenewInterval.current);
    typingRenewInterval.current = null;
    void client.sendTyping(roomId, false, 0).catch(() => undefined);
    void sendBehavior("typing-stop", durationMs);
  }

  // After we rewrite the input value ourselves (mention insertion), put the
  // caret back where the participant expects it rather than at the end.
  useEffect(() => {
    if (desiredCaret.current === null || !inputRef.current) return;
    inputRef.current.setSelectionRange(desiredCaret.current, desiredCaret.current);
    inputRef.current.focus();
    desiredCaret.current = null;
  }, [input]);

  function updateInput(value: string, caret?: number) {
    setInput(value);
    const pos = caret ?? value.length;
    const next = detectMention(value, pos);
    setMention(next);
    setMentionIndex(0);
    if (!roomId) return;
    const activeRoomId = roomId;
    if (value.trim() && typingStartedAt.current === null) {
      typingStartedAt.current = Date.now();
      void client
        .sendTyping(activeRoomId, true, TYPING_SERVER_TIMEOUT_MS)
        .catch(() => undefined);
      typingRenewInterval.current = setInterval(() => {
        if (typingStartedAt.current === null) return;
        void client
          .sendTyping(activeRoomId, true, TYPING_SERVER_TIMEOUT_MS)
          .catch(() => undefined);
      }, TYPING_RENEW_INTERVAL_MS);
      void sendBehavior("typing-start");
    }
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    if (!value.trim()) stopTyping();
    else typingStopTimer.current = setTimeout(stopTyping, TYPING_IDLE_TIMEOUT_MS);
  }

  async function sendMessage() {
    if (!input.trim() || !roomId) return;
    const body = input.trim();
    stopTyping();
    setInput("");
    setMention(null);
    setSendError(false);
    try {
      await client.sendTextMessage(roomId, body);
    } catch {
      // Don't lose the participant's words: restore them and say so.
      setInput((current) => current || body);
      setSendError(true);
    }
  }

  // Other participants offered in the "@" picker, filtered by what's typed.
  const mentionCandidates =
    mention === null
      ? []
      : [...identities.entries()]
          .filter(([id]) => id !== userId)
          .map(([, ident]) => ident)
          .filter((ident) =>
            ident.name.toLowerCase().startsWith(mention.query.toLowerCase()),
          )
          .sort((a, b) => a.name.localeCompare(b.name));
  const mentionOpen = mentionCandidates.length > 0;

  // Replace the half-typed "@query" with "@Name " and drop the picker.
  function selectMention(name: string) {
    if (mention === null) return;
    const caret = inputRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, mention.start);
    const after = input.slice(caret);
    const insert = `@${name} `;
    const next = before + insert + after;
    desiredCaret.current = before.length + insert.length;
    setMention(null);
    setMentionIndex(0);
    updateInput(next, desiredCaret.current);
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const chosen = mentionCandidates[mentionIndex] ?? mentionCandidates[0];
        selectMention(chosen.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  return {
    inputRef,
    input,
    updateInput,
    sendMessage,
    sendError,
    onInputKeyDown,
    mentionCandidates,
    mentionOpen,
    mentionIndex,
    setMentionIndex,
    selectMention,
  };
}
