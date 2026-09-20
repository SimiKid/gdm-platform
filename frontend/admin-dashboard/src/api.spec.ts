import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_BASE,
  apiFetch,
  exportPath,
  exportUrl,
  getAdminToken,
  isTestCondition,
  setAdminToken,
} from "./api";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin token storage", () => {
  it("is empty until a token is saved, then persists across reloads", () => {
    expect(getAdminToken()).toBe("");
    setAdminToken("secret");
    expect(getAdminToken()).toBe("secret");
    expect(localStorage.getItem("gdm-admin-token")).toBe("secret");
  });

  it("migrates a token saved per-tab by older releases", () => {
    sessionStorage.setItem("gdm-admin-token", "legacy");
    expect(getAdminToken()).toBe("legacy");
    expect(localStorage.getItem("gdm-admin-token")).toBe("legacy");
    expect(sessionStorage.getItem("gdm-admin-token")).toBeNull();
  });

  it("clears both stores when an empty token is set", () => {
    localStorage.setItem("gdm-admin-token", "a");
    sessionStorage.setItem("gdm-admin-token", "b");
    setAdminToken("");
    expect(localStorage.getItem("gdm-admin-token")).toBeNull();
    expect(sessionStorage.getItem("gdm-admin-token")).toBeNull();
  });

  it("degrades to no token when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getAdminToken()).toBe("");
    expect(() => setAdminToken("x")).not.toThrow();
  });
});

describe("apiFetch", () => {
  it("prefixes the API base and attaches the bearer token", async () => {
    setAdminToken("secret");
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/sessions", { method: "POST", headers: { "X-Test": "1" } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/sessions`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("X-Test")).toBe("1");
  });

  it("sends no Authorization header without a token", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/sessions");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Headers).has("Authorization")).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises automated e2e conditions", () => {
    expect(isTestCondition("e2e-1234")).toBe(true);
    expect(isTestCondition("baseline")).toBe(false);
  });

  it("builds credential-free export URLs with an optional query", () => {
    expect(exportUrl("/export/research.zip", "")).toBe(`${API_BASE}/export/research.zip`);
    expect(exportUrl("/export/research.zip", "roundIds=1,2")).toBe(
      `${API_BASE}/export/research.zip?roundIds=1%2C2`,
    );
    expect(exportPath("/export/windows.csv", "")).toBe("/export/windows.csv");
    expect(exportPath("/export/windows.csv", "conditionIds=a")).toBe(
      "/export/windows.csv?conditionIds=a",
    );
  });
});
