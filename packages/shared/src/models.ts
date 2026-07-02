/**
 * Domain models for the GDM Study Platform.
 *
 * These mirror the entities in the architecture sketch (Session, Chat,
 * Nachricht/Message, Participant) and are the shared contract between the
 * backend services and the frontends. Persistence shape (columns, relations)
 * is owned by the Session Manager's repository layer; these are the
 * transport/domain types everyone codes against.
 */

/** A named survey answer set (entry or exit questionnaire). */
export interface Survey {
  /** Question id -> answer. Kept generic until the instruments are fixed. */
  answers: Record<string, string | number | boolean>;
  submittedAt: string; // ISO 8601
}

/** A member of a hiring committee taking part in a study session. */
export interface Participant {
  id: string;
  name: string;
  entrySurvey?: Survey;
  exitSurvey?: Survey;
}

/** Emoji / acknowledgment reaction attached to a message. */
export interface Reaction {
  key: string; // e.g. "👍" or "m.acknowledged"
  senderId: string;
  timestamp: string; // ISO 8601
}

/**
 * A single chat message (sketch: "Nachricht").
 * recipientId is set only for private messages (e.g. a private bot nudge);
 * omit / null for messages sent to the whole group room.
 */
export interface Message {
  id: string;
  timestamp: string; // ISO 8601
  senderId: string;
  recipientId?: string | null;
  text: string;
  reactions: Reaction[];
}

/** The ordered message log of a session (sketch: "Chat"). */
export interface Chat {
  messages: Message[];
}

/**
 * An experimental condition assigned to a session. The concrete knobs
 * (bot behavior, nudge rules, resources shown) are filled in as the study
 * design firms up; id + name are the stable contract for now.
 */
export interface Condition {
  id: string;
  name: string;
  /** Opaque, condition-specific configuration consumed by the bot. */
  config: Record<string, unknown>;
}

/** Which nudge behavior the bot runs for a session. */
export interface BotConfig {
  /** Rule-based only for milestone 1; LLM check is optional/future. */
  llmEnabled: boolean;
  condition: Condition;
}

export type SessionStatus = "open" | "running" | "completed" | "aborted";

/**
 * A single run of a group decision-making session (sketch: "Session").
 * Owns its participants, the chat log, the assigned condition and bot config.
 */
export interface Session {
  id: string;
  status: SessionStatus;
  condition: Condition;
  bot: BotConfig;
  participants: Participant[];
  chat: Chat;
  /** Matrix room id backing this session, once provisioned. */
  roomId?: string;
  createdAt: string; // ISO 8601
  completedAt?: string; // ISO 8601
}
