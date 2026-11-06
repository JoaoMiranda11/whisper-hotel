import { describe, expect, it } from 'vitest';
import { signVoicePass, verifyVoicePass } from '../src/voicePass.js';

const SECRET = 'test-voice-secret-0123456789abcdef0123456789';
const NOW = 1_800_000_000;

describe('voice pass', () =>
{
    it('round-trips a valid pass', () =>
    {
        const pass = signVoicePass(SECRET, { userId: 42, expiresAt: NOW + 60 });

        expect(verifyVoicePass(SECRET, pass, NOW)).toEqual({ ok: true, claims: { userId: 42, expiresAt: NOW + 60 } });
    });

    it('rejects a pass signed with another secret', () =>
    {
        const pass = signVoicePass('another-secret-0123456789abcdef0123456789', { userId: 42, expiresAt: NOW + 60 });

        expect(verifyVoicePass(SECRET, pass, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects a pass whose user id was tampered with', () =>
    {
        const [ , exp, sig ] = signVoicePass(SECRET, { userId: 42, expiresAt: NOW + 60 }).split('.');

        expect(verifyVoicePass(SECRET, `43.${ exp }.${ sig }`, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects an expired pass', () =>
    {
        const pass = signVoicePass(SECRET, { userId: 42, expiresAt: NOW });

        expect(verifyVoicePass(SECRET, pass, NOW)).toEqual({ ok: false, reason: 'expired' });
    });

    it.each([ '', 'abc', '42.123', '0.123.' + 'a'.repeat(43), '42.123.' + 'a'.repeat(42), '99999999999.1.' + 'a'.repeat(43) ])('rejects malformed pass %j', value =>
    {
        expect(verifyVoicePass(SECRET, value, NOW)).toEqual({ ok: false, reason: 'malformed' });
    });
});
