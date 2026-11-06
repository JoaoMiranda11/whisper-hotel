import { RoomObjectCategory, RoomObjectType } from '@nitrots/nitro-renderer';
import { GetRoomEngine, GetRoomSession, GetSessionDataManager } from '../nitro';
import { PositionSnapshot } from './ProximityVoiceClient';

/**
 * Tile positions of every human avatar in the given room, keyed by Arcturus users.id (= LiveKit identity).
 * Uses the interpolated room-object location, so walking avatars move smoothly between ticks.
 */
export const GetVoicePositionSnapshot = (roomId: number): PositionSnapshot =>
{
    const snapshot: PositionSnapshot = { self: null, peers: new Map() };
    const session = GetRoomSession();

    if(!session || (session.roomId !== roomId)) return snapshot;

    const ownUserId = GetSessionDataManager().userId;
    const objects = GetRoomEngine().getRoomObjects(roomId, RoomObjectCategory.UNIT) || [];

    for(const object of objects)
    {
        if(!object || (object.id < 0)) continue;

        const userData = session.userDataManager.getUserDataByIndex(object.id);

        if(!userData || (userData.type !== RoomObjectType.USER)) continue;

        const location = object.getLocation();

        if(!location) continue;

        const position = { x: location.x, y: location.y };

        if(userData.webID === ownUserId) snapshot.self = position;
        else snapshot.peers.set(String(userData.webID), position);
    }

    return snapshot;
};
