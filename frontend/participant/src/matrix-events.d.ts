import type { BehavioralEventType, Ranking } from "@gdm/shared";

/**
 * Content types of the study's custom Matrix timeline events (see
 * MATRIX_EVENT_TYPES), so `client.sendEvent` type-checks them without casts.
 */
declare module "matrix-js-sdk/lib/@types/event" {
  interface TimelineEvents {
    "de.gdm.ranking": Ranking;
    "de.gdm.behavior": {
      type: BehavioralEventType;
      durationMs?: number;
      [measure: string]: string | number | undefined;
    };
  }
}
