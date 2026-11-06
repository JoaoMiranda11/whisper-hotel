/**
 * Single source of truth for proximity voice tuning.
 * Every key can be overridden from ui-config.json under "voice" (see GetVoiceConfig).
 * This file must stay free of renderer/React imports: it is used by unit tests.
 */
export interface VoiceConfig
{
    /** Master switch. Voice is also disabled when sidecarUrl is empty. */
    enabled: boolean;
    /** Base URL of voice-sidecar, e.g. http://127.0.0.1:8090 or https://hotel.example.com/voice-api */
    sidecarUrl: string;
    /** Subscribe when a peer is at or within this many tiles; gain reaches 0 here. */
    hearRadius: number;
    /** Keep an existing subscription until the peer is farther than this (hysteresis). */
    unsubscribeRadius: number;
    /** Max simultaneous remote audio subscriptions (closest win). */
    maxSubscriptions: number;
    /** Proximity loop period. Never per frame. */
    tickMs: number;
    /** Stereo panning from the isometric screen dx. */
    stereoPan: boolean;
    /** 0..1, how hard to pan at the edge of the hearing radius. */
    panStrength: number;
    /** KeyboardEvent.code of the push-to-talk key. */
    pushToTalkKey: string;
    /** Start with push-to-talk on (otherwise open mic + mute button). */
    pushToTalkDefault: boolean;
}

export const DEFAULT_VOICE_CONFIG: Readonly<VoiceConfig> = Object.freeze({
    enabled: true,
    sidecarUrl: '',
    hearRadius: 8,
    unsubscribeRadius: 9,
    maxSubscriptions: 10,
    tickMs: 200,
    stereoPan: true,
    panStrength: 0.6,
    pushToTalkKey: 'KeyV',
    pushToTalkDefault: false
});

const isFiniteNumber = (value: unknown): value is number => (typeof value === 'number') && Number.isFinite(value);

/** Merges untrusted overrides (from JSON config) over the defaults, ignoring wrongly typed values. */
export const resolveVoiceConfig = (overrides: Partial<Record<keyof VoiceConfig, unknown>> | null | undefined): VoiceConfig =>
{
    const config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG };

    if(!overrides || (typeof overrides !== 'object')) return config;

    for(const key of Object.keys(DEFAULT_VOICE_CONFIG) as (keyof VoiceConfig)[])
    {
        const value = overrides[key];

        if(value === undefined || (typeof value !== typeof DEFAULT_VOICE_CONFIG[key])) continue;
        if((typeof value === 'number') && !isFiniteNumber(value)) continue;

        (config as unknown as Record<string, unknown>)[key] = value;
    }

    config.hearRadius = Math.max(0.5, config.hearRadius);
    config.unsubscribeRadius = Math.max(config.hearRadius, config.unsubscribeRadius);
    config.maxSubscriptions = Math.max(0, Math.floor(config.maxSubscriptions));
    config.tickMs = Math.max(50, config.tickMs);
    config.panStrength = Math.min(1, Math.max(0, config.panStrength));
    config.sidecarUrl = config.sidecarUrl.replace(/\/+$/, '');

    return config;
};
