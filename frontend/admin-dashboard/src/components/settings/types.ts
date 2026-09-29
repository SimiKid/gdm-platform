import type { ConditionProgress } from "@gdm/shared";

export type SaveState = "idle" | "saving" | "saved" | "error";

/** Cards that edit the study arms get the polled rows and a refresh hook. */
export interface ArmRowsProps {
  rows: ConditionProgress[];
  /** Re-fetch dashboard data after a successful save. */
  onSaved: () => void;
}
