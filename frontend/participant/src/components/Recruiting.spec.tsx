import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Recruiting from "./Recruiting";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("Recruiting", () => {
  it("shows the no-link state and offers developer login without ?p=", async () => {
    const onDevLogin = vi.fn();
    render(<Recruiting onEnter={vi.fn()} onDevLogin={onDevLogin} />);
    expect(screen.getByText(/No valid study link/)).toBeInTheDocument();
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
