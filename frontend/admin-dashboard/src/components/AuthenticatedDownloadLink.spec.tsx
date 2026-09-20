import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthenticatedDownloadLink from "./AuthenticatedDownloadLink";
import { API_BASE, setAdminToken } from "../api";
import { calledPaths, mockApi } from "../test-utils";

describe("AuthenticatedDownloadLink", () => {
  let anchorClick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setAdminToken("secret");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:download"),
      revokeObjectURL: vi.fn(),
    });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the token out of the href and downloads through an authenticated fetch", async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ "/export/research.zip": { ok: true } });
    render(
      <AuthenticatedDownloadLink path="/export/research.zip" query="roundIds=2" filename="research_bundle.zip">
        Bundle
      </AuthenticatedDownloadLink>,
    );
    const link = screen.getByRole("link", { name: "Bundle" });
    expect(link).toHaveAttribute("href", `${API_BASE}/export/research.zip?roundIds=2`);
    expect(link.getAttribute("href")).not.toContain("secret");

    await user.click(link);

    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(calledPaths(fetchMock)).toEqual(["/export/research.zip?roundIds=2"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer secret");
    const clicked = anchorClick.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(clicked.download).toBe("research_bundle.zip");
    expect(clicked.href).toBe("blob:download");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed download inline", async () => {
    const user = userEvent.setup();
    mockApi({ "/export/linkage.csv": { status: 401 } });
    render(
      <AuthenticatedDownloadLink path="/export/linkage.csv" filename="linkage.csv">
        Linkage
      </AuthenticatedDownloadLink>,
    );
    await user.click(screen.getByRole("link", { name: "Linkage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Download failed");
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it("ignores clicks while a download is in flight", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, blob: async () => new Blob(["x"]) });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthenticatedDownloadLink path="/export/windows.csv" filename="windows.csv">
        Windows
      </AuthenticatedDownloadLink>,
    );
    await user.click(screen.getByRole("link", { name: "Windows" }));
    expect(screen.getByRole("link")).toHaveTextContent("Preparing download…");
    expect(screen.getByRole("link")).toHaveAttribute("aria-busy", "true");
    await user.click(screen.getByRole("link"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByRole("link")).toHaveTextContent("Windows"));
  });
});
