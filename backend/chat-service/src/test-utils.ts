/**
 * Test-only helpers shared by the unit specs. Excluded from the build
 * (tsconfig.build.json) and from coverage (vitest.config.ts).
 */
import { vi } from "vitest";
import type { MatrixBotService } from "./matrix/matrix-bot.service";

/** A MatrixBotService double: sends succeed, the room has `memberIds` joined. */
export function fakeBot(
  memberIds: string[],
  botUserId = "@gdm_bot:localhost",
): MatrixBotService {
  return {
    botUserId,
    sendText: vi.fn(async () => undefined),
    getJoinedMemberIds: vi.fn(async () => memberIds),
  } as unknown as MatrixBotService;
}
