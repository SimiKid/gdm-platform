import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyPad } from "@gdm/shared";
import EtherpadTask from "./EtherpadTask";
import { workspaceClient } from "../study/workspaceClient";

vi.mock("../study/workspaceClient", () => ({ workspaceClient: { pad: vi.fn(), finish: vi.fn() } }));
const openPad = (): StudyPad => ({ id: "gdm-test", phase: "entry", deadline: new Date(Date.now() + 300000).toISOString(), state: "open", text: null, revision: null, embedUrl: "/etherpad/p/gdm-test#grant" });
const captured = (): StudyPad => ({ ...openPad(), state: "captured", text: "Partial response", revision: 5, embedUrl: undefined });

describe("EtherpadTask", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(workspaceClient.pad).mockResolvedValue(openPad()); vi.mocked(workspaceClient.finish).mockResolvedValue(captured()); });
  afterEach(() => vi.useRealTimers());

  it("waits for an authenticated iframe flush acknowledgement before saving and advancing", async () => {
    const complete = vi.fn(); render(<EtherpadTask phase="entry" onComplete={complete} />);
    const frame = await screen.findByTitle("entry writing workspace") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.click(screen.getByRole("button", { name: "Submit my response" }));
    expect(workspaceClient.finish).not.toHaveBeenCalled();
    const requestId = post.mock.calls[0][0].requestId;
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://stranger.invalid", source: frame.contentWindow, data: { type: "gdm-flushed", requestId } })));
    expect(workspaceClient.finish).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: location.origin, source: frame.contentWindow, data: { type: "gdm-flushed", requestId } })));
    await waitFor(() => expect(complete).toHaveBeenCalledWith(expect.objectContaining({ text: "Partial response", state: "captured" })));
  });
  it("captures partial text exactly once at the server-provided deadline", async () => {
    vi.useFakeTimers(); const complete = vi.fn();
    vi.mocked(workspaceClient.pad).mockResolvedValue({ ...openPad(), deadline: new Date(Date.now() + 1000).toISOString() });
    render(<EtherpadTask phase="entry" onComplete={complete} />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(workspaceClient.finish).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("does not advance when an expired draft fails to save, and supports retry", async () => {
    vi.mocked(workspaceClient.pad).mockResolvedValue({ ...openPad(), deadline: new Date(Date.now() - 1000).toISOString() });
    vi.mocked(workspaceClient.finish).mockRejectedValueOnce(new Error("Capture unavailable"));
    const complete = vi.fn(); render(<EtherpadTask phase="exit" sessionId="session" onComplete={complete} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Capture unavailable");
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });
  it("resumes a captured response without opening an editor or restarting its timer", async () => {
    vi.mocked(workspaceClient.pad).mockResolvedValue(captured());
    const complete = vi.fn(); render(<EtherpadTask phase="entry" onComplete={complete} />);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(screen.queryByTitle("entry writing workspace")).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
    expect(workspaceClient.finish).not.toHaveBeenCalled();
  });
  it("automatically waits for the server to finish the discussion before starting the final pad", async () => {
    vi.useFakeTimers();
    const pending = Object.assign(new Error("Discussion has not finished"), { code: "DISCUSSION_PENDING" });
    vi.mocked(workspaceClient.pad)
      .mockRejectedValueOnce(pending)
      .mockRejectedValueOnce(pending)
      .mockImplementation(async () => ({ ...openPad(), phase: "exit", deadline: new Date(Date.now() + 120_000).toISOString() }));
    render(<EtherpadTask phase="exit" sessionId="session" />);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("will open automatically");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(workspaceClient.pad).toHaveBeenCalledTimes(3);
    expect(screen.getByTitle("exit writing workspace")).toBeInTheDocument();
    expect(workspaceClient.finish).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(119_000); });
    expect(workspaceClient.finish).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(workspaceClient.finish).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending discussion retry when leaving the screen", async () => {
    vi.useFakeTimers();
    vi.mocked(workspaceClient.pad).mockRejectedValue(Object.assign(new Error("Waiting"), { code: "DISCUSSION_PENDING" }));
    const view = render(<EtherpadTask phase="exit" sessionId="session" />);
    await act(async () => {});
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(workspaceClient.pad).toHaveBeenCalledTimes(1);
  });
  it("keeps real opening errors visible instead of retrying indefinitely", async () => {
    vi.useFakeTimers();
    vi.mocked(workspaceClient.pad).mockRejectedValue(new Error("Writing study access required"));
    render(<EtherpadTask phase="exit" sessionId="session" />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Writing study access required");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(workspaceClient.pad).toHaveBeenCalledTimes(1);
  });
});
