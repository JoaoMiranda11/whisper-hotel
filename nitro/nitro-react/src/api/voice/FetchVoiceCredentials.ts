import { VoiceCredentials, VoiceTokenError } from './ProximityVoiceClient';

const REQUEST_TIMEOUT_MS = 8000;

export const FetchVoiceCredentials = async (sidecarUrl: string, voicePass: string, roomId: number): Promise<VoiceCredentials> =>
{
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;

    try
    {
        response = await fetch(`${ sidecarUrl }/voice-token?room=${ encodeURIComponent(String(roomId)) }`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${ voicePass }` },
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal
        });
    }
    catch(error)
    {
        throw new VoiceTokenError('token_failed', `voice-sidecar unreachable: ${ (error as Error)?.message }`);
    }
    finally
    {
        clearTimeout(timeout);
    }

    if((response.status === 401) || (response.status === 403)) throw new VoiceTokenError('unauthorized', 'voice pass rejected');
    if(!response.ok) throw new VoiceTokenError('token_failed', `voice-sidecar HTTP ${ response.status }`);

    const body = await response.json() as Partial<VoiceCredentials>;

    if(!body || (typeof body.token !== 'string') || (typeof body.url !== 'string')) throw new VoiceTokenError('token_failed', 'malformed voice-sidecar response');

    return { token: body.token, url: body.url };
};
