import { z } from 'zod';

const originList = z
    .string()
    .min(1)
    .transform(value => value.split(',').map(origin => origin.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }).transform(origin => new URL(origin).origin)).min(1));

const envSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8090),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum([ 'fatal', 'error', 'warn', 'info', 'debug', 'trace' ]).default('info'),
    LK_KEY: z.string().min(1),
    LK_SECRET: z.string().min(32, 'LK_SECRET must be at least 32 characters'),
    LK_PUBLIC_URL: z.url({ protocol: /^wss?$/ }),
    VOICE_AUTH_SECRET: z.string().min(32, 'VOICE_AUTH_SECRET must be at least 32 characters'),
    NITRO_ORIGIN: originList
});

export interface AppConfig
{
    port: number;
    host: string;
    logLevel: string;
    livekit: { apiKey: string; apiSecret: string; publicUrl: string };
    voiceAuthSecret: string;
    allowedOrigins: string[];
}

export const loadConfig = (env: NodeJS.ProcessEnv): AppConfig =>
{
    const parsed = envSchema.safeParse(env);

    if(!parsed.success)
    {
        const issues = parsed.error.issues.map(issue => `${ issue.path.join('.') }: ${ issue.message }`).join('; ');

        throw new Error(`Invalid voice-sidecar configuration: ${ issues }`);
    }

    const e = parsed.data;

    return {
        port: e.PORT,
        host: e.HOST,
        logLevel: e.LOG_LEVEL,
        livekit: { apiKey: e.LK_KEY, apiSecret: e.LK_SECRET, publicUrl: e.LK_PUBLIC_URL },
        voiceAuthSecret: e.VOICE_AUTH_SECRET,
        allowedOrigins: e.NITRO_ORIGIN
    };
};
