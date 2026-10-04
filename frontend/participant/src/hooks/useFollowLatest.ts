import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keep following the conversation only while the participant is already at
 * the bottom. If they scroll up to read, preserve that position and surface a
 * WhatsApp-style count of new messages instead of pulling the viewport away.
 */
export function useFollowLatest(
  messages: { isOwn: boolean }[],
  roomId: string | null,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const previousMessageCount = useRef(0);
  const isNearMessageEnd = useRef(true);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    isNearMessageEnd.current = true;
    setNewMessageCount(0);
    endRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    previousMessageCount.current = 0;
    isNearMessageEnd.current = true;
    setNewMessageCount(0);
  }, [roomId]);

  useEffect(() => {
    const previousCount = previousMessageCount.current;
    const addedCount = Math.max(0, messages.length - previousCount);
    const addedMessages =
      addedCount > 0 ? messages.slice(messages.length - addedCount) : [];
    previousMessageCount.current = messages.length;

    if (messages.length === 0) {
      setNewMessageCount(0);
      return;
    }
    if (
      previousCount === 0 ||
      isNearMessageEnd.current ||
      addedMessages.some((message) => message.isOwn)
    ) {
      scrollToLatest(previousCount === 0 ? "auto" : "smooth");
    } else if (addedCount > 0) {
      setNewMessageCount((count) => count + addedCount);
    }
  }, [messages, scrollToLatest]);

  function trackScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const nearEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
    isNearMessageEnd.current = nearEnd;
    if (nearEnd) setNewMessageCount(0);
  }

  return { viewportRef, endRef, newMessageCount, scrollToLatest, trackScroll };
}
