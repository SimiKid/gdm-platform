import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { RoomMemberEvent } from "matrix-js-sdk";
import { buildIdentities, identityFor, isBot, type Identity } from "@gdm/shared";

/** Pseudonyms of the other participants currently typing (Matrix typing). */
export function useTypingMembers(
  client: MatrixClient,
  roomId: string | null,
  userId: string,
  identities?: Map<string, Identity>,
): string[] {
  const [typingMembers, setTypingMembers] = useState<string[]>([]);

  useEffect(() => {
    if (!roomId) return;
    const activeRoomId = roomId;
    function refreshTyping() {
      const room = client.getRoom(activeRoomId);
      const members =
        room
          ?.getJoinedMembers()
          .filter(
            (member) =>
              member.userId !== userId && member.typing && !isBot(member.userId),
          )
          .map(
            (member) =>
              identityFor(
                identities ?? buildIdentities(
                  room.getJoinedMembers().map((item) => item.userId),
                ),
                member.userId,
              ).name,
          ) ?? [];
      setTypingMembers(members);
    }
    client.on(RoomMemberEvent.Typing, refreshTyping);
    client.on(RoomMemberEvent.Membership, refreshTyping);
    refreshTyping();
    return () => {
      client.off(RoomMemberEvent.Typing, refreshTyping);
      client.off(RoomMemberEvent.Membership, refreshTyping);
    };
  }, [client, roomId, userId, identities]);

  return typingMembers;
}
