import { AccessToken, TrackSource } from 'livekit-server-sdk';

export const TOKEN_TTL_SECONDS = 15 * 60;

export const livekitRoomName = (roomId: number): string => `habbo:${ roomId }`;

export interface VoiceTokenInput
{
    apiKey: string;
    apiSecret: string;
    userId: number;
    roomId: number;
}

/**
 * identity = Arcturus users.id. The grant is scoped to a single room and to microphone only,
 * so a modified client cannot publish video/screen or data even though it is "trusted".
 */
export const createVoiceToken = async (input: VoiceTokenInput): Promise<string> =>
{
    const token = new AccessToken(input.apiKey, input.apiSecret, {
        identity: String(input.userId),
        ttl: TOKEN_TTL_SECONDS
    });

    token.addGrant({
        roomJoin: true,
        room: livekitRoomName(input.roomId),
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: [ TrackSource.MICROPHONE ],
        canUpdateOwnMetadata: false
    });

    return token.toJwt();
};
