/**
 * Pure proximity logic: ranking, hysteresis, gain and pan. No React, no renderer, no LiveKit.
 * Positions are in room tiles (x, y); z/height is ignored on purpose.
 */
export interface TilePosition
{
    x: number;
    y: number;
}

export interface ProximityPeer
{
    /** LiveKit identity (= Arcturus users.id as string). */
    id: string;
    /** null when the peer has no avatar in the room we know about (yet). */
    position: TilePosition | null;
}

export interface ProximityParams
{
    hearRadius: number;
    unsubscribeRadius: number;
    maxSubscriptions: number;
    stereoPan: boolean;
    panStrength: number;
}

/** Phase 2 extension point (wall occlusion). Must return a multiplier in [0, 1]. */
export type OcclusionFactor = (listener: TilePosition, source: TilePosition) => number;

export const occlusionFactor: OcclusionFactor = () => 1;

export interface ProximityDecision
{
    /** Peers that should be subscribed after this tick. */
    subscribed: Set<string>;
    /** Volume (0..1) per subscribed peer. */
    gains: Map<string, number>;
    /** Stereo pan (-1..1) per subscribed peer; 0 when panning is disabled. */
    pans: Map<string, number>;
}

export const tileDistance = (a: TilePosition, b: TilePosition): number => Math.hypot((a.x - b.x), (a.y - b.y));

/** gain = (1 - d / R)^2, clamped to [0, 1]. Peers kept by hysteresis (R < d <= R') are silent. */
export const computeGain = (distance: number, hearRadius: number): number =>
{
    if(!Number.isFinite(distance) || (hearRadius <= 0) || (distance >= hearRadius)) return 0;

    const linear = (1 - (Math.max(0, distance) / hearRadius));

    return (linear * linear);
};

/**
 * Isometric projection: screen x grows with (x - y). Positive pan = source to the listener's right.
 * Scaled so a peer at hearRadius straight to the side pans by panStrength.
 */
export const computePan = (listener: TilePosition, source: TilePosition, hearRadius: number, panStrength: number): number =>
{
    const screenDx = ((source.x - source.y) - (listener.x - listener.y)) / Math.SQRT2;
    const pan = (screenDx / Math.max(hearRadius, 1e-6)) * panStrength;

    return Math.max(-1, Math.min(1, pan));
};

/**
 * Chooses which peers to subscribe to.
 * - eligible: d <= hearRadius, or already subscribed and d <= unsubscribeRadius (hysteresis)
 * - closest first; ties favour already-subscribed peers, then identity, for stable output
 * - at most maxSubscriptions
 */
export const selectSubscriptions = (listener: TilePosition | null, peers: readonly ProximityPeer[], current: ReadonlySet<string>, params: ProximityParams): Map<string, number> =>
{
    const selected = new Map<string, number>();

    if(!listener || (params.maxSubscriptions <= 0)) return selected;

    const eligible: { id: string, distance: number, wasSubscribed: boolean }[] = [];

    for(const peer of peers)
    {
        if(!peer.position) continue;

        const distance = tileDistance(listener, peer.position);
        const wasSubscribed = current.has(peer.id);
        const limit = (wasSubscribed ? params.unsubscribeRadius : params.hearRadius);

        if(distance <= limit) eligible.push({ id: peer.id, distance, wasSubscribed });
    }

    eligible.sort((a, b) =>
    {
        if(a.distance !== b.distance) return (a.distance - b.distance);
        if(a.wasSubscribed !== b.wasSubscribed) return (a.wasSubscribed ? -1 : 1);

        return ((a.id < b.id) ? -1 : ((a.id > b.id) ? 1 : 0));
    });

    for(const entry of eligible.slice(0, params.maxSubscriptions)) selected.set(entry.id, entry.distance);

    return selected;
};

export const computeProximity = (listener: TilePosition | null, peers: readonly ProximityPeer[], current: ReadonlySet<string>, params: ProximityParams, occlusion: OcclusionFactor = occlusionFactor): ProximityDecision =>
{
    const selected = selectSubscriptions(listener, peers, current, params);
    const positions = new Map<string, TilePosition>();

    for(const peer of peers) if(peer.position) positions.set(peer.id, peer.position);

    const decision: ProximityDecision = { subscribed: new Set(selected.keys()), gains: new Map(), pans: new Map() };

    for(const [ id, distance ] of selected)
    {
        const source = positions.get(id);
        const factor = Math.max(0, Math.min(1, occlusion(listener, source)));

        decision.gains.set(id, (computeGain(distance, params.hearRadius) * factor));
        decision.pans.set(id, (params.stereoPan ? computePan(listener, source, params.hearRadius, params.panStrength) : 0));
    }

    return decision;
};
