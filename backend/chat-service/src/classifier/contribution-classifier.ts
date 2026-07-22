import type { ContributionClassification, Message } from "@gdm/shared";

/** Everything the meaningfulness classifier needs besides the message itself. */
export interface ClassifierContext {
  /** All prior messages, oldest → newest; implementations use the last 3. */
  priorMessages: Message[];
  /** Labels of the ranking-task items. */
  taskItems: string[];
  /** Matrix user ids of all group members (pseudonymized in the prompt). */
  participantIds: string[];
}

export interface ContributionClassifier {
  classify(
    message: Message,
    context: ClassifierContext,
  ): Promise<ContributionClassification | null>;
}
