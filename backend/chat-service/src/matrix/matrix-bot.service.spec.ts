import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { MatrixBotService } from "./matrix-bot.service";

type FetchMock = ReturnType<typeof vi.fn> & {
  mock: { calls: [string, { method: string; body: string }][] };
};

describe("MatrixBotService", () => {
  beforeEach(() => {
    vi.stubEnv("MATRIX_RATE_LIMIT_RETRIES", "0");
    vi.stubEnv("MATRIX_RETRY_MAX_DELAY_MS", "1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sendText PUTs an m.room.message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await new MatrixBotService().sendText("!r", "hello");
    const [url, opts] = (fetch as unknown as FetchMock).mock.calls[0];
    expect(url).toContain("/send/m.room.message/");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toMatchObject({ msgtype: "m.text", body: "hello" });
    vi.unstubAllGlobals();
  });

  it("sendText merges extraContent for a private nudge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await new MatrixBotService().sendText("!r", "psst", {
      "de.gdm.recipient": "@u:localhost",
    });
    const body = JSON.parse((fetch as unknown as FetchMock).mock.calls[0][1].body);
    expect(body["de.gdm.recipient"]).toBe("@u:localhost");
    vi.unstubAllGlobals();
  });

  it("retries a rate-limited send with the same idempotent transaction id", async () => {
    vi.stubEnv("MATRIX_RATE_LIMIT_RETRIES", "1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after_ms: 1 }), { status: 429 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new MatrixBotService().sendText("!r", "hello once");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(fetchMock.mock.calls[1][0]);
  });

  it("registers a named comparison identity once and sends under its token", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/register")) {
        return {
          ok: true,
          json: async () => ({
            user_id: "@gdm_bot_b_x1:localhost",
            access_token: "token-b",
          }),
        };
      }
      return { ok: true };
    });
    vi.stubGlobal("fetch", fetchMock);
    const bot = new MatrixBotService();

    await bot.joinAs("b", "!r");
    await bot.sendTextAs("b", "!r", "nudge from B");

    const registerCalls = fetchMock.mock.calls.filter(([url]) =>
      (url as string).includes("/register"),
    );
    expect(registerCalls).toHaveLength(1);
    expect(JSON.parse(registerCalls[0][1]!.body as string).username).toMatch(
      /^gdm_bot_b_/,
    );
    const sendCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes("/send/m.room.message/"),
    );
    expect(sendCall![1]!.headers).toMatchObject({
      Authorization: "Bearer token-b",
    });
    vi.unstubAllGlobals();
  });

  it("join throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    await expect(new MatrixBotService().join("!r")).rejects.toThrow(/join failed/);
    vi.unstubAllGlobals();
  });

  it("getJoinedMemberIds returns joined Matrix user ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          joined: {
            "@a:localhost": {},
            "@b:localhost": {},
          },
        }),
      })),
    );
    await expect(new MatrixBotService().getJoinedMemberIds("!r")).resolves.toEqual([
      "@a:localhost",
      "@b:localhost",
    ]);
    vi.unstubAllGlobals();
  });

  it("paginates room history and returns only session events in order", async () => {
    const event = (id: string, ts: number) => ({
      type: "m.room.message",
      sender: "@u:localhost",
      event_id: id,
      origin_server_ts: ts,
      content: { body: id },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ chunk: [event("m3", 300), event("m2", 200)], end: "p1" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ chunk: [event("m1", 100), event("old", 99)], end: "p2" }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const history = await new MatrixBotService().roomHistory("!r", 100);

    expect(history.map((item) => item.eventId)).toEqual(["m1", "m2", "m3"]);
    expect(String(fetchMock.mock.calls[1][0])).toContain("from=p1");
  });

  it("registers and delivers timeline events from /sync to handlers", async () => {
    const bot = new MatrixBotService();
    const events: { roomId: string; type: string; eventId: string }[] = [];
    bot.onTimelineEvent((e) => {
      events.push(e);
      bot.stop(); // exit the loop after the first delivered event
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/register")) {
          return {
            ok: true,
            json: async () => ({
              user_id: "@bot:localhost",
              access_token: "tok",
            }),
          };
        }
        if (url.includes("timeout=0")) {
          return { ok: true, json: async () => ({ next_batch: "s0" }) };
        }
        return {
          ok: true,
          json: async () => ({
            next_batch: "s1",
            rooms: {
              join: {
                "!r": {
                  timeline: {
                    events: [
                      {
                        type: "m.room.message",
                        sender: "@u:localhost",
                        event_id: "m1",
                        origin_server_ts: 1,
                        content: { body: "hi" },
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      }),
    );

    await bot.onModuleInit();
    bot.start();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(bot.botUserId).toBe("@bot:localhost");
    expect(events[0]).toMatchObject({ roomId: "!r", type: "m.room.message", eventId: "m1" });
    vi.unstubAllGlobals();
  });
});
