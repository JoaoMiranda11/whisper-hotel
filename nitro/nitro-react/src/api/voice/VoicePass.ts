/**
 * Voice pass handed to friends in the entry URL (?vp=<userId>.<exp>.<sig>), minted by
 * voice-sidecar/scripts/mint-link.ts. The browser cannot verify the signature (no secret here);
 * it only parses it to catch wrong/expired links early. The sidecar is the authority.
 */
export interface VoicePass
{
    raw: string;
    userId: number;
    expiresAt: number;
}

const PASS_PATTERN = /^([1-9]\d{0,9})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const URL_PARAM = 'vp';
const STORAGE_KEY = 'nitro.voice.pass';

export const parseVoicePass = (raw: string | null | undefined): VoicePass | null =>
{
    if(!raw) return null;

    const match = PASS_PATTERN.exec(raw.trim());

    if(!match) return null;

    return { raw: raw.trim(), userId: Number(match[1]), expiresAt: Number(match[2]) };
};

export const isVoicePassExpired = (pass: VoicePass, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean => (pass.expiresAt <= nowSeconds);

let cachedPass: VoicePass | null | undefined = undefined;

/**
 * Reads ?vp= once, keeps it in sessionStorage (survives reloads of this tab) and removes it from
 * the address bar so it doesn't end up in bookmarks/screenshots.
 */
export const GetVoicePass = (): VoicePass | null =>
{
    if(cachedPass !== undefined) return cachedPass;

    let raw: string | null = null;

    try
    {
        const url = new URL(window.location.href);

        raw = url.searchParams.get(URL_PARAM);

        if(raw)
        {
            url.searchParams.delete(URL_PARAM);
            window.history.replaceState(window.history.state, '', url.toString());

            try
            {
                window.sessionStorage.setItem(STORAGE_KEY, raw);
            }
            catch
            {
                // storage may be blocked; keep it in memory only
            }
        }
        else
        {
            try
            {
                raw = window.sessionStorage.getItem(STORAGE_KEY);
            }
            catch
            {
                raw = null;
            }
        }
    }
    catch
    {
        raw = null;
    }

    cachedPass = parseVoicePass(raw);

    return cachedPass;
};
