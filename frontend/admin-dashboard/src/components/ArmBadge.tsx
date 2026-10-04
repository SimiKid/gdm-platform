import type { Condition } from "@gdm/shared";

const DELIVERY_LABELS: Record<string, string> = {
  baseline: "No nudges",
  public: "📢 Public",
  private: "🔒 Private",
};

/** Read-only badge naming how an arm delivers its nudges. */
export default function ArmBadge({ condition }: { condition: Condition }) {
  const mode = condition.config.interventionMode;
  return <span className="arm">{DELIVERY_LABELS[mode] ?? mode}</span>;
}
