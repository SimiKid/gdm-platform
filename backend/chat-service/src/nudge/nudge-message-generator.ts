export interface NudgeMessageContext {
  targetName: string;
  contributionPercent: number;
  otherParticipantNames: string[];
  previousMessages: string[];
}

export interface NudgeMessageGenerator {
  generate(context: NudgeMessageContext): Promise<string | null>;
}
