import type { ContributionClassification, Message } from "@gdm/shared";

export interface ContributionClassifier {
  classify(
    message: Message,
    context: Message[],
  ): Promise<ContributionClassification | null>;
}
