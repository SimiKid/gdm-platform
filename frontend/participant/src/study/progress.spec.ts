import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProgress,
  loadProgress,
  saveProgress,
  updateStage,
  type StudyProgress,
} from "./progress";

const progress: StudyProgress = {
  stage: "waiting",
  sessionId: "session-1",
  participantId: "participant-1",
  matrix: {
    homeserverUrl: "http://synapse",
    userId: "@p1:localhost",
    accessToken: "token",
    roomId: "",
  },
};

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("study progress persistence", () => {
  it("round-trips the progress through sessionStorage", () => {
    expect(loadProgress()).toBeNull();
    saveProgress(progress);
    expect(loadProgress()).toEqual(progress);
  });

  it("updates only the stage of an existing record", () => {
    saveProgress(progress);
    updateStage("chat");
    expect(loadProgress()).toEqual({ ...progress, stage: "chat" });
  });

  it("does nothing on updateStage when nothing was saved yet", () => {
    updateStage("exit");
    expect(loadProgress()).toBeNull();
  });

  it("clears the record", () => {
    saveProgress(progress);
    clearProgress();
    expect(loadProgress()).toBeNull();
  });

  it("ignores malformed or incomplete records", () => {
    sessionStorage.setItem("gdm-study-progress", "{not json");
    expect(loadProgress()).toBeNull();
    sessionStorage.setItem(
      "gdm-study-progress",
      JSON.stringify({ stage: "chat", sessionId: "s" }),
    );
    expect(loadProgress()).toBeNull();
  });

  it("swallows storage failures instead of breaking the flow", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveProgress(progress)).not.toThrow();
    expect(() => clearProgress()).not.toThrow();
    expect(loadProgress()).toBeNull();
  });
});
