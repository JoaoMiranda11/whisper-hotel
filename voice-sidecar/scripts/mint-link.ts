/**
 * Mints a voice pass for a friend and prints their entry link.
 *
 *   VOICE_AUTH_SECRET=... npm run mint-link -- --user 2 --days 30 [--sso <auth_ticket>]
 *
 * The pass must belong to the same Arcturus user the SSO ticket logs in as; the client refuses
 * to connect voice if they differ.
 */
import { parseArgs } from 'node:util';
import { signVoicePass } from '../src/voicePass.js';

const { values } = parseArgs({
    options: {
        user: { type: 'string' },
        days: { type: 'string', default: '30' },
        sso: { type: 'string' },
        base: { type: 'string', default: process.env['NITRO_PUBLIC_URL'] ?? 'http://127.0.0.1:1080' }
    }
});

const secret = process.env['VOICE_AUTH_SECRET'];
const userId = Number(values.user);
const days = Number(values.days);

if(!secret || secret.length < 32) throw new Error('VOICE_AUTH_SECRET (>= 32 chars) is required');
if(!Number.isInteger(userId) || userId <= 0) throw new Error('--user <users.id> is required');
if(!Number.isFinite(days) || days <= 0 || days > 365) throw new Error('--days must be in (0, 365]');

const expiresAt = Math.floor(Date.now() / 1000) + Math.round(days * 86_400);
const pass = signVoicePass(secret, { userId, expiresAt });

const url = new URL(values.base);
url.searchParams.set('sso', values.sso ?? 'SSO_TICKET_HERE');
url.searchParams.set('vp', pass);

process.stdout.write(`user=${ userId } expires=${ new Date(expiresAt * 1000).toISOString() }\n${ url.toString() }\n`);
