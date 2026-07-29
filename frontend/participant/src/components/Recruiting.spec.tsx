import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Recruiting from "./Recruiting";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  sessionStorage.clear();
});

describe("Recruiting", () => {
  it("self-issues a tracking token for the generic link (no ?p=)", async () => {
    const onEnter = vi.fn();
    render(<Recruiting onEnter={onEnter} />);
    expect(screen.getByText(/Welcome to the study/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Start"));
    const token = onEnter.mock.calls[0][0] as string;
    expect(token).toBeTruthy();
    // Persisted per tab so a refresh reuses the same identity.
    expect(sessionStorage.getItem("gdm-tracking-token")).toBe(token);
  });

  it("reuses the stored token on a refresh instead of minting a new one", async () => {
    sessionStorage.setItem("gdm-tracking-token", "kept-token");
    const onEnter = vi.fn();
    render(<Recruiting onEnter={onEnter} />);
    await userEvent.click(screen.getByText("Start"));
    expect(onEnter).toHaveBeenCalledWith("kept-token", undefined, undefined);
  });

  it("reads the tracking token from ?p= and enters the flow directly", () => {
    window.history.replaceState(
      {},
      "",
      "/?p=abc123&conditionId=private-llm",
    );
    const onEnter = vi.fn();
    render(<Recruiting onEnter={onEnter} />);
    expect(onEnter).toHaveBeenCalledWith("abc123", "private-llm");
    // token stripped from the URL
    expect(window.location.search).toBe("?conditionId=private-llm");
  });

  it("captures all Prolific IDs and strips them from the visible URL", () => {
    const pid = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const studyId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const sessionId = "cccccccccccccccccccccccc";
    window.history.replaceState(
      {},
      "",
      `/?PROLIFIC_PID=${pid}&STUDY_ID=${studyId}&SESSION_ID=${sessionId}`,
    );
    const onEnter = vi.fn();
    render(<Recruiting onEnter={onEnter} />);

    expect(onEnter).toHaveBeenCalledWith(
      `prolific:${studyId}:${sessionId}`,
      undefined,
      { participantId: pid, studyId, sessionId },
    );
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("gdm-prolific-identity")).toContain(pid);
  });

  it("rejects an incomplete Prolific link instead of minting a generic token", () => {
    window.history.replaceState(
      {},
      "",
      "/?PROLIFIC_PID=aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const onEnter = vi.fn();
    render(<Recruiting onEnter={onEnter} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/incomplete/i);
    expect(onEnter).not.toHaveBeenCalled();
  });
});
