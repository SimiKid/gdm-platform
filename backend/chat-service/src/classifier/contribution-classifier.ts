import type {
  ClassificationFailure,
  ContributionClassification,
  Message,
} from "@gdm/shared";

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
  /**
   * Classify one message. Never throws: on API failure it returns a
   * {@link ClassificationFailure} so coverage gaps are part of the research
   * record instead of vanishing. Discriminate with {@link isClassification}.
   */
  classify(
    message: Message,
    context: ClassifierContext,
  ): Promise<ContributionClassification | ClassificationFailure>;
}

export function isClassification(
  result: ContributionClassification | ClassificationFailure,
): result is ContributionClassification {
  return "meaningfulnessScore" in result;
}
