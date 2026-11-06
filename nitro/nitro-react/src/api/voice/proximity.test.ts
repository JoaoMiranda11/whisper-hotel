import { describe, expect, it } from 'vitest';
import { computeGain, computePan, computeProximity, ProximityParams, ProximityPeer, selectSubscriptions, tileDistance } from './proximity';
import { DEFAULT_VOICE_CONFIG, resolveVoiceConfig } from './VoiceConfig';
import { isVoicePassExpired, parseVoicePass } from './VoicePass';

const PARAMS: ProximityParams = {
    hearRadius: 8,
    unsubscribeRadius: 9,
    maxSubscriptions: 10,
    stereoPan: true,
    panStrength: 0.6
};

const ORIGIN = { x: 10, y: 10 };
const peerAt = (id: string, dx: number, dy = 0): ProximityPeer => ({ id, position: { x: ORIGIN.x + dx, y: ORIGIN.y + dy }});
const NONE = new Set<string>();

describe('tileDistance', () =>
{
    it('is euclidean in tiles', () =>
    {
        expect(tileDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    });
});

describe('computeGain', () =>
{
    it('follows (1 - d/R)^2', () =>
    {
        expect(computeGain(0, 8)).toBe(1);
        expect(computeGain(4, 8)).toBeCloseTo(0.25);
        expect(computeGain(6, 8)).toBeCloseTo(0.0625);
    });

    it('is silent at and beyond the hearing radius', () =>
    {
        expect(computeGain(8, 8)).toBe(0);
        expect(computeGain(8.5, 8)).toBe(0);
        expect(computeGain(Infinity, 8)).toBe(0);
        expect(computeGain(NaN, 8)).toBe(0);
    });

    it('decreases monotonically', () =>
    {
        let previous = Infinity;

        for(let d = 0; d <= 8; d += 0.25)
        {
            const gain = computeGain(d, 8);

            expect(gain).toBeLessThanOrEqual(previous);
            previous = gain;
        }
    });
});

describe('selectSubscriptions (hysteresis)', () =>
{
    it('subscribes at <= 8 tiles, not beyond', () =>
    {
        const result = selectSubscriptions(ORIGIN, [ peerAt('a', 8), peerAt('b', 8.01) ], NONE, PARAMS);

        expect([ ...result.keys() ]).toEqual([ 'a' ]);
    });

    it('keeps an existing subscription up to 9 tiles', () =>
    {
        const result = selectSubscriptions(ORIGIN, [ peerAt('a', 8.9) ], new Set([ 'a' ]), PARAMS);

        expect(result.has('a')).toBe(true);
    });

    it('drops an existing subscription beyond 9 tiles', () =>
    {
        const result = selectSubscriptions(ORIGIN, [ peerAt('a', 9.01) ], new Set([ 'a' ]), PARAMS);

        expect(result.size).toBe(0);
    });

    it('does not oscillate when hovering around 8.5 tiles', () =>
    {
        let current = new Set<string>();

        current = new Set(selectSubscriptions(ORIGIN, [ peerAt('a', 7.9) ], current, PARAMS).keys());
        expect(current.has('a')).toBe(true);

        for(const d of [ 8.2, 8.6, 8.4, 8.9, 8.1 ])
        {
            current = new Set(selectSubscriptions(ORIGIN, [ peerAt('a', d) ], current, PARAMS).keys());
            expect(current.has('a')).toBe(true);
        }

        current = new Set(selectSubscriptions(ORIGIN, [ peerAt('a', 9.5) ], current, PARAMS).keys());
        expect(current.has('a')).toBe(false);

        current = new Set(selectSubscriptions(ORIGIN, [ peerAt('a', 8.5) ], current, PARAMS).keys());
        expect(current.has('a')).toBe(false);
    });

    it('ignores peers without a known position', () =>
    {
        const result = selectSubscriptions(ORIGIN, [ { id: 'ghost', position: null } ], NONE, PARAMS);

        expect(result.size).toBe(0);
    });

    it('subscribes to nobody when the listener has no position', () =>
    {
        expect(selectSubscriptions(null, [ peerAt('a', 1) ], NONE, PARAMS).size).toBe(0);
    });
});

describe('selectSubscriptions (ranking / MAX_SUBS)', () =>
{
    it('keeps only the 10 closest', () =>
    {
        const peers = Array.from({ length: 15 }, (_, i) => peerAt(`p${ i }`, (i * 0.5)));
        const result = selectSubscriptions(ORIGIN, peers, NONE, PARAMS);

        expect(result.size).toBe(10);
        expect([ ...result.keys() ]).toEqual(peers.slice(0, 10).map(peer => peer.id));
    });

    it('prefers already-subscribed peers on distance ties', () =>
    {
        const peers = [ peerAt('a', 3), peerAt('b', 0, 3) ];
        const result = selectSubscriptions(ORIGIN, peers, new Set([ 'b' ]), { ...PARAMS, maxSubscriptions: 1 });

        expect([ ...result.keys() ]).toEqual([ 'b' ]);
    });

    it('a hysteresis-kept peer loses its slot to a closer newcomer', () =>
    {
        const result = selectSubscriptions(ORIGIN, [ peerAt('far', 8.8), peerAt('near', 2) ], new Set([ 'far' ]), { ...PARAMS, maxSubscriptions: 1 });

        expect([ ...result.keys() ]).toEqual([ 'near' ]);
    });

    it('subscribes to nobody when maxSubscriptions is 0', () =>
    {
        expect(selectSubscriptions(ORIGIN, [ peerAt('a', 1) ], NONE, { ...PARAMS, maxSubscriptions: 0 }).size).toBe(0);
    });
});

describe('computePan', () =>
{
    it('is centred for a peer straight "in depth" (same x - y)', () =>
    {
        expect(computePan(ORIGIN, { x: 13, y: 13 }, 8, 0.6)).toBeCloseTo(0);
    });

    it('pans right for +x and left for +y (isometric)', () =>
    {
        expect(computePan(ORIGIN, { x: 14, y: 10 }, 8, 0.6)).toBeGreaterThan(0);
        expect(computePan(ORIGIN, { x: 10, y: 14 }, 8, 0.6)).toBeLessThan(0);
    });

    it('is clamped to [-1, 1]', () =>
    {
        expect(computePan(ORIGIN, { x: 1000, y: 0 }, 8, 1)).toBe(1);
        expect(computePan(ORIGIN, { x: 0, y: 1000 }, 8, 1)).toBe(-1);
    });
});

describe('computeProximity', () =>
{
    it('returns gains and pans only for subscribed peers', () =>
    {
        const decision = computeProximity(ORIGIN, [ peerAt('near', 2), peerAt('far', 20) ], NONE, PARAMS);

        expect([ ...decision.subscribed ]).toEqual([ 'near' ]);
        expect(decision.gains.get('near')).toBeCloseTo((1 - (2 / 8)) ** 2);
        expect(decision.gains.has('far')).toBe(false);
        expect(decision.pans.get('near')).toBeGreaterThan(0);
    });

    it('gives a hysteresis-kept peer zero gain', () =>
    {
        const decision = computeProximity(ORIGIN, [ peerAt('a', 8.5) ], new Set([ 'a' ]), PARAMS);

        expect(decision.subscribed.has('a')).toBe(true);
        expect(decision.gains.get('a')).toBe(0);
    });

    it('applies the occlusion factor (phase 2 extension point), clamped to [0, 1]', () =>
    {
        expect(computeProximity(ORIGIN, [ peerAt('a', 0) ], NONE, PARAMS, () => 0.5).gains.get('a')).toBe(0.5);
        expect(computeProximity(ORIGIN, [ peerAt('a', 0) ], NONE, PARAMS, () => 7).gains.get('a')).toBe(1);
    });

    it('does not pan when stereo is disabled', () =>
    {
        expect(computeProximity(ORIGIN, [ peerAt('a', 3) ], NONE, { ...PARAMS, stereoPan: false }).pans.get('a')).toBe(0);
    });
});

describe('resolveVoiceConfig', () =>
{
    it('returns defaults for empty overrides', () =>
    {
        expect(resolveVoiceConfig(null)).toEqual(DEFAULT_VOICE_CONFIG);
    });

    it('applies valid overrides and ignores wrongly typed ones', () =>
    {
        const config = resolveVoiceConfig({ hearRadius: 6, maxSubscriptions: '3', sidecarUrl: 'http://x:8090/' });

        expect(config.hearRadius).toBe(6);
        expect(config.maxSubscriptions).toBe(10);
        expect(config.sidecarUrl).toBe('http://x:8090');
    });

    it('keeps unsubscribeRadius >= hearRadius', () =>
    {
        expect(resolveVoiceConfig({ hearRadius: 10, unsubscribeRadius: 5 }).unsubscribeRadius).toBe(10);
    });
});

describe('parseVoicePass', () =>
{
    const sig = 'a'.repeat(43);

    it('parses a well-formed pass', () =>
    {
        expect(parseVoicePass(`42.1800000000.${ sig }`)).toEqual({ raw: `42.1800000000.${ sig }`, userId: 42, expiresAt: 1800000000 });
    });

    it.each([ null, '', '42', '0.1.' + sig, '42.1.short', 'x.1.' + sig ])('rejects %j', value =>
    {
        expect(parseVoicePass(value)).toBeNull();
    });

    it('detects expiry', () =>
    {
        const pass = parseVoicePass(`1.100.${ sig }`);

        expect(isVoicePassExpired(pass, 100)).toBe(true);
        expect(isVoicePassExpired(pass, 99)).toBe(false);
    });
});
