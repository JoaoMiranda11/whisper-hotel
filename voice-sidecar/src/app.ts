import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { createVoiceToken, livekitRoomName } from './token.js';
import { verifyVoicePass } from './voicePass.js';

const MAX_ROOM_ID = 2_147_483_647;

const voiceTokenQuery = z.object({
    room: z
        .string()
        .regex(/^[1-9]\d{0,9}$/, 'room must be a positive integer')
        .transform(Number)
        .refine(value => value <= MAX_ROOM_ID, 'room out of range')
});

const BEARER = /^Bearer ([^\s]+)$/;

export interface BuildAppOptions
{
    logger?: FastifyServerOptions['logger'];
    /** Injected clock (unix seconds), for tests. */
    now?: () => number;
}

export const buildApp = async (config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> =>
{
    const now = options.now ?? (() => Math.floor(Date.now() / 1000));

    const app = Fastify({
        logger: options.logger ?? {
            level: config.logLevel,
            // Default request serializer doesn't log headers; redact anyway in case a serializer is added later.
            redact: { paths: [ 'req.headers.authorization' ], remove: true }
        }
    });

    await app.register(cors, {
        origin: config.allowedOrigins,
        methods: [ 'GET' ],
        allowedHeaders: [ 'Authorization' ],
        maxAge: 600
    });

    app.get('/health', async () => ({ status: 'ok' }));

    app.get('/voice-token', async (request, reply) =>
    {
        void reply.header('Cache-Control', 'no-store');

        // Auth first: unauthenticated callers learn nothing about query validation.
        const match = BEARER.exec(request.headers.authorization ?? '');

        if(!match?.[1])
        {
            request.log.warn({ reason: 'missing' }, 'voice auth failed');

            return reply.code(401).send({ error: 'unauthorized' });
        }

        const pass = verifyVoicePass(config.voiceAuthSecret, match[1], now());

        if(!pass.ok)
        {
            request.log.warn({ reason: pass.reason }, 'voice auth failed');

            return reply.code(401).send({ error: 'unauthorized' });
        }

        const query = voiceTokenQuery.safeParse(request.query);

        if(!query.success)
        {
            return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues.map(issue => issue.message) });
        }

        const { userId } = pass.claims;
        const roomId = query.data.room;

        const token = await createVoiceToken({
            apiKey: config.livekit.apiKey,
            apiSecret: config.livekit.apiSecret,
            userId,
            roomId
        });

        request.log.info({ userId, room: livekitRoomName(roomId) }, 'voice token issued');

        return { token, url: config.livekit.publicUrl };
    });

    return app;
};
