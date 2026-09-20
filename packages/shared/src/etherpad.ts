export type StudyTaskMode = "ranking" | "etherpad";
export type PadPhase = "entry" | "group" | "exit";
export interface EtherpadStatus {
  enabled: boolean;
  state: "stopped" | "starting" | "ready" | "draining" | "stopping" | "error";
  activeParticipants: number;
  error?: string;
}
export interface StudyAdmission { mode: StudyTaskMode }
export interface StudyPad {
  id: string;
  phase: PadPhase;
  deadline: string;
  state: "open" | "captured" | "error";
  text: string | null;
  revision: number | null;
  capturedAt?: string;
  embedUrl?: string;
  error?: string;
}
export interface StudyPadSnapshot extends Omit<StudyPad, "embedUrl"> {
  sessionId?: string;
  participantId?: string;
  conditionId?: string;
  roundId?: number;
}
