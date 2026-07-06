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
    render(<Recruiting onEnter={onEnter} onDevLogin={vi.fn()} />);
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
    render(<Recruiting onEnter={onEnter} onDevLogin={vi.fn()} />);
    await userEvent.click(screen.getByText("Start"));
    expect(onEnter).toHaveBeenCalledWith("kept-token", undefined);
  });

  it("still offers developer login", async () => {
    const onDevLogin = vi.fn();
    render(<Recruiting onEnter={vi.fn()} onDevLogin={onDevLogin} />);
    await userEvent.click(screen.getByText(/Developer login/));
    expect(onDevLogin).toHaveBeenCalled();
  });

  it("reads the tracking token from ?p= and enters the flow on Start", async () => {
    window.history.replaceState(
      {},
      "",
      "/?p=abc123&conditionId=private-engaging",
    );
    const onEnter = vi.fn();
    render(<Recruiting onEnter={onEnter} onDevLogin={vi.fn()} />);
    expect(screen.getByText(/Welcome to the study/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Start"));
    expect(onEnter).toHaveBeenCalledWith("abc123", "private-engaging");
    // token stripped from the URL
    expect(window.location.search).toBe("?conditionId=private-engaging");
  });
});
