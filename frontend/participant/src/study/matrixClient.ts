import { createClient, ClientEvent, EventTimeline } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { OpenSessionResponse } from "@gdm/shared";

/** Stored Matrix credentials; the room id is unknown while still waiting. */
export type MatrixCredentials = Omit<OpenSessionResponse["matrix"], "roomId"> & {
  roomId?: string;
};

const SYNC_TIMEOUT_MS = 15_000;

/** Create (but do not start) a Matrix client for the given credentials. */
export function createMatrixClient(credentials: MatrixCredentials): MatrixClient {
  return createClient({
    baseUrl: credentials.homeserverUrl,
    accessToken: credentials.accessToken,
    userId: credentials.userId,
  });
}

/** Start the client's sync loop and wait until the first sync is prepared. */
export async function syncMatrixClient(client: MatrixClient): Promise<void> {
  await client.startClient({ initialSyncLimit: 20 });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Could not connect to the chat server")),
      SYNC_TIMEOUT_MS,
    );
    client.once(ClientEvent.Sync, (state: string) => {
      clearTimeout(timeout);
      if (state === "PREPARED") resolve();
      else reject(new Error(`Chat connection failed (${state})`));
    });
  });
}

/**
 * Start a Matrix client from stored credentials and wait for the first sync.
 * After sync, backfill the room timeline so reloads never lose messages.
 */
export async function startMatrixClient(
  credentials: MatrixCredentials,
): Promise<MatrixClient> {
  const client = createMatrixClient(credentials);
  await syncMatrixClient(client);

  // Study rooms are small — backfill the full timeline so a page reload never
  // drops earlier messages that fell outside the initialSyncLimit window.
  if (credentials.roomId) {
    const room = client.getRoom(credentials.roomId);
    if (room) {
      const timeline = room.getLiveTimeline();
      while (timeline.getPaginationToken(EventTimeline.BACKWARDS)) {
        await client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: 100,
        });
      }
    }
  }

  return client;
}
