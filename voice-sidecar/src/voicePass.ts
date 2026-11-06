import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Voice pass: `<userId>.<expiresAtUnixSeconds>.<base64url(HMAC-SHA256(secret, "v1.<userId>.<exp>"))>`
 *
 * It is minted out-of-band (scripts/mint-link.ts) and handed to a friend inside their
 * entry URL. It is NOT the Arcturus auth_ticket, which is consumed on login.
 */
export interface VoicePassClaims
{
    userId: number;
    expiresAt: number;
}

export type VoicePassFailure = 'malformed' | 'bad_signature' | 'expired';

export type VoicePassResult =
    | { ok: true; claims: VoicePassClaims }
    | { ok: false; reason: VoicePassFailure };

const PASS_VERSION = 'v1';
const PASS_PATTERN = /^([1-9]\d{0,9})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const MAX_USER_ID = 2_147_483_647;

const computeSignature = (secret: string, userId: number, expiresAt: number): Buffer =>
    createHmac('sha256', secret).update(`${ PASS_VERSION }.${ userId }.${ expiresAt }`).digest();

export const signVoicePass = (secret: string, claims: VoicePassClaims): string =>
{
    if(!Number.isInteger(claims.userId) || claims.userId <= 0 || claims.userId > MAX_USER_ID) throw new RangeError('userId must be a positive int32');
    if(!Number.isInteger(claims.expiresAt) || claims.expiresAt <= 0) throw new RangeError('expiresAt must be a positive unix timestamp (seconds)');

    const signature = computeSignature(secret, claims.userId, claims.expiresAt).toString('base64url');

    return `${ claims.userId }.${ claims.expiresAt }.${ signature }`;
};

export const verifyVoicePass = (secret: string, pass: string, nowSeconds: number): VoicePassResult =>
{
    const match = PASS_PATTERN.exec(pass);

    if(!match) return { ok: false, reason: 'malformed' };

    const userId = Number(match[1]);
    const expiresAt = Number(match[2]);
    const provided = Buffer.from(match[3] ?? '', 'base64url');

    if(userId > MAX_USER_ID) return { ok: false, reason: 'malformed' };

    const expected = computeSignature(secret, userId, expiresAt);

    if(provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_signature' };

    if(expiresAt <= nowSeconds) return { ok: false, reason: 'expired' };

    return { ok: true, claims: { userId, expiresAt } };
};
