import { TokenVerifier } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { TOKEN_TTL_SECONDS } from '../src/token.js';
import { signVoicePass } from '../src/voicePass.js';

const NOW = 1_800_000_000;

const config: AppConfig = loadConfig({
    LK_KEY: 'test-key',
    LK_SECRET: 'test-livekit-secret-0123456789abcdef0123',
    LK_PUBLIC_URL: 'ws://127.0.0.1:7880',
    VOICE_AUTH_SECRET: 'test-voice-secret-0123456789abcdef0123456789',
    NITRO_ORIGIN: 'http://127.0.0.1:1080, http://localhost:1080'
});

const passFor = (userId: number, expiresAt = NOW + 3600): string => signVoicePass(config.voiceAuthSecret, { userId, expiresAt });

describe('voice-sidecar', () =>
{
    let app: FastifyInstance;

    beforeEach(async () =>
    {
        app = await buildApp(config, { logger: false, now: () => NOW });
    });

    afterEach(async () =>
    {
        await app.close();
    });

    it('GET /health', async () =>
    {
        const res = await app.inject({ method: 'GET', url: '/health' });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok' });
    });

    describe('auth', () =>
    {
        it.each([
            [ 'no header', undefined ],
            [ 'not bearer', 'Basic abc' ],
            [ 'garbage', 'Bearer not-a-pass' ],
            [ 'wrong secret', `Bearer ${ signVoicePass('some-other-secret-0123456789abcdef01234567', { userId: 1, expiresAt: NOW + 60 }) }` ],
            [ 'expired', `Bearer ${ passFor(1, NOW - 1) }` ]
        ])('401 when %s', async (_label, authorization) =>
        {
            const res = await app.inject({
                method: 'GET',
                url: '/voice-token?room=10',
                headers: authorization ? { authorization } : {}
            });

            expect(res.statusCode).toBe(401);
            expect(res.json()).toEqual({ error: 'unauthorized' });
        });

        it('checks auth before the query (401 wins over 400)', async () =>
        {
            const res = await app.inject({ method: 'GET', url: '/voice-token?room=abc' });

            expect(res.statusCode).toBe(401);
        });
    });

    describe('query validation', () =>
    {
        it.each([ '', '?room=', '?room=abc', '?room=0', '?room=-5', '?room=1.5', '?room=01', '?room=2147483648', '?room=10&room=11' ])('400 for %j', async query =>
        {
            const res = await app.inject({
                method: 'GET',
                url: `/voice-token${ query }`,
                headers: { authorization: `Bearer ${ passFor(7) }` }
            });

            expect(res.statusCode).toBe(400);
            expect(res.json().error).toBe('invalid_query');
        });
    });

    describe('token', () =>
    {
        it('returns a token scoped to habbo:<room> with mic-only, no-data grants', async () =>
        {
            const res = await app.inject({
                method: 'GET',
                url: '/voice-token?room=123',
                headers: { authorization: `Bearer ${ passFor(7) }` }
            });

            expect(res.statusCode).toBe(200);
            expect(res.headers['cache-control']).toBe('no-store');

            const body = res.json<{ token: string; url: string }>();

            expect(body.url).toBe('ws://127.0.0.1:7880');

            // Real wall clock here: the JWT is signed with the actual time.
            const claims = await new TokenVerifier(config.livekit.apiKey, config.livekit.apiSecret).verify(body.token);

            expect(claims.sub).toBe('7');
            expect(claims.video).toEqual({
                roomJoin: true,
                room: 'habbo:123',
                canPublish: true,
                canSubscribe: true,
                canPublishData: false,
                canPublishSources: [ 'microphone' ],
                canUpdateOwnMetadata: false
            });

            const payload = JSON.parse(Buffer.from(body.token.split('.')[1] ?? '', 'base64url').toString()) as { exp: number; nbf: number };

            expect(payload.exp - payload.nbf).toBe(TOKEN_TTL_SECONDS);
        });

        it('rejects a token signed with a different LiveKit secret', async () =>
        {
            const res = await app.inject({
                method: 'GET',
                url: '/voice-token?room=1',
                headers: { authorization: `Bearer ${ passFor(7) }` }
            });

            await expect(new TokenVerifier(config.livekit.apiKey, 'wrong-secret-0123456789abcdef0123456789').verify(res.json().token)).rejects.toThrow();
        });
    });

    describe('cors', () =>
    {
        it('allows the Nitro origin', async () =>
        {
            const res = await app.inject({
                method: 'OPTIONS',
                url: '/voice-token?room=1',
                headers: { origin: 'http://127.0.0.1:1080', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }
            });

            expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:1080');
        });

        it('does not allow other origins', async () =>
        {
            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { origin: 'https://evil.example' }
            });

            expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });
    });

    describe('config', () =>
    {
        it('fails fast on missing secrets', () =>
        {
            expect(() => loadConfig({ LK_KEY: 'k' })).toThrow(/Invalid voice-sidecar configuration/);
        });
    });
});
