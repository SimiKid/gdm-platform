import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent, RoomMemberEvent } from "matrix-js-sdk";

/**
 * Resolve the room the chat shows: the session's room in study mode, else the
 * first joined room (dev fast-path). Also re-renders the caller whenever a
 * room or membership arrives through sync.
 */
export function useActiveRoom(
  client: MatrixClient,
  sessionRoomId: string | undefined,
): string | null {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    sessionRoomId ?? null,
  );
  const [, refreshRoomMembership] = useState(0);

  useEffect(() => {
    if (sessionRoomId) {
      setActiveRoomId(sessionRoomId);
      return;
    }
    function pickFirst() {
      const joined = client.getRooms();
      if (joined.length > 0) setActiveRoomId((cur) => cur ?? joined[0].roomId);
    }
    pickFirst();
    client.on(ClientEvent.Room, pickFirst);
    return () => {
      client.off(ClientEvent.Room, pickFirst);
    };
  }, [client, sessionRoomId]);

  // The Session Manager joins every participant before publishing the room id,
  // but each browser still learns that room state asynchronously through
  // Matrix sync. Re-render when the room or a membership arrives so the study
  // never remains on the neutral loading state until an unrelated message.
  useEffect(() => {
    const refresh = () => refreshRoomMembership((revision) => revision + 1);
    client.on(ClientEvent.Room, refresh);
    client.on(RoomMemberEvent.Membership, refresh);
    return () => {
      client.off(ClientEvent.Room, refresh);
      client.off(RoomMemberEvent.Membership, refresh);
    };
  }, [client]);

  return activeRoomId;
}
