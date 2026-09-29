import { useCallback, useEffect, useRef } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import type { BehavioralEventType } from "@gdm/shared";

export type SendBehavior = (
  type: BehavioralEventType,
  durationMs?: number,
  payload?: Record<string, number>,
) => Promise<void>;

const CURSOR_FLUSH_INTERVAL_MS = 10_000;

/**
 * Durable interaction telemetry for the research data: returns a sender for
 * custom behavior events and records tab visibility and batched cursor
 * activity while a room is active.
 */
export function useBehaviorTelemetry(
  client: MatrixClient,
  roomId: string | null,
): SendBehavior {
  const cursorActivity = useRef({
    sampleCount: 0,
    distancePx: 0,
    lastX: 0,
    lastY: 0,
    hasPoint: false,
  });

  const sendBehavior = useCallback<SendBehavior>(
    async (type, durationMs, payload = {}) => {
      if (!roomId) return;
      try {
        await client.sendEvent(roomId, MATRIX_EVENT_TYPES.behavior, {
          type,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...payload,
        });
      } catch {
        // Telemetry must never block the participant's chat interaction.
      }
    },
    [roomId, client],
  );

  useEffect(() => {
    if (!roomId) return;
    function onVisibilityChange() {
      void sendBehavior(document.hidden ? "tab-hidden" : "tab-visible");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [roomId, sendBehavior]);

  // Batch pointer activity so research gets cursor engagement measures without
  // flooding Matrix with a raw event for every mouse movement.
  useEffect(() => {
    if (!roomId) return;
    function onPointerMove(event: PointerEvent) {
      const activity = cursorActivity.current;
      if (activity.hasPoint) {
        activity.distancePx += Math.hypot(
          event.clientX - activity.lastX,
          event.clientY - activity.lastY,
        );
      }
      activity.sampleCount += 1;
      activity.lastX = event.clientX;
      activity.lastY = event.clientY;
      activity.hasPoint = true;
    }
    const interval = setInterval(() => {
      const activity = cursorActivity.current;
      if (activity.sampleCount > 0) {
        void sendBehavior("cursor-activity", undefined, {
          sampleCount: activity.sampleCount,
          distancePx: Math.round(activity.distancePx),
          lastX: Math.round(activity.lastX),
          lastY: Math.round(activity.lastY),
        });
      }
      cursorActivity.current = {
        sampleCount: 0,
        distancePx: 0,
        lastX: activity.lastX,
        lastY: activity.lastY,
        hasPoint: activity.hasPoint,
      };
    }, CURSOR_FLUSH_INTERVAL_MS);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      clearInterval(interval);
    };
  }, [roomId, sendBehavior]);

  return sendBehavior;
}
