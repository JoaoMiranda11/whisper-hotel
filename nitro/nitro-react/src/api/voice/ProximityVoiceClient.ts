import { createLocalAudioTrack, DisconnectReason, LocalAudioTrack, Participant, RemoteAudioTrack, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent, Track } from 'livekit-client';
import { computeProximity, occlusionFactor, OcclusionFactor, ProximityParams, TilePosition } from './proximity';

export type VoiceStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'error';

export type VoiceErrorCode =
    | 'insecure_context' // no HTTPS: listen-only, mic unavailable
    | 'mic_denied' // permission refused: listen-only
    | 'mic_unavailable' // no device / device busy: listen-only
    | 'no_pass' // entry link without ?vp=
    | 'pass_expired'
    | 'pass_mismatch' // voice pass is for another Arcturus user
    | 'unauthorized' // sidecar rejected the pass
    | 'token_failed' // sidecar unreachable / 5xx
    | 'connect_failed' // LiveKit unreachable (ports / TURN / URL)
    | 'disconnected'; // dropped by the server (e.g. same user in another tab)

export interface VoiceState
{
    status: VoiceStatus;
    roomId: number | null;
    error: VoiceErrorCode | null;
    /** Mic track published (permission granted). */
    micPublished: boolean;
    /** Mic actually transmitting right now (unmuted / PTT held). */
    micLive: boolean;
    /** False until the browser lets us play audio (autoplay policy): call startAudio() from a click. */
    canPlaybackAudio: boolean;
    /** LiveKit identities (= users.id) currently speaking, including ourselves. */
    speakingIdentities: string[];
}

export interface VoiceCredentials
{
    token: string;
    url: string;
}

export class VoiceTokenError extends Error
{
    constructor(public readonly code: Extract<VoiceErrorCode, 'unauthorized' | 'token_failed'>, message: string)
    {
        super(message);
    }
}

export interface PositionSnapshot
{
    self: TilePosition | null;
    /** identity -> tile position, for every human avatar in the room. */
    peers: Map<string, TilePosition>;
}

export interface ProximityVoiceClientDeps
{
    fetchCredentials: (roomId: number) => Promise<VoiceCredentials>;
    getPositions: (roomId: number) => PositionSnapshot;
    params: ProximityParams;
    tickMs: number;
    occlusion?: OcclusionFactor;
    onState: (state: VoiceState) => void;
    log?: (message: string, details?: unknown) => void;
}

/** publishTrack can hang forever on a client/server protocol mismatch; fail visibly instead. */
const PUBLISH_TIMEOUT_MS = 10000;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => new Promise<T>((resolve, reject) =>
{
    const timer = setTimeout(() => reject(new Error(`${ label } timed out after ${ ms } ms`)), ms);

    promise
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
});

const INITIAL_STATE: VoiceState = {
    status: 'idle',
    roomId: null,
    error: null,
    micPublished: false,
    micLive: false,
    canPlaybackAudio: true,
    speakingIdentities: []
};

/**
 * Owns at most ONE LiveKit room connection and keeps it in sync with the Habbo room we're in.
 *
 * Race handling: every call to setTargetRoom() bumps `generation`. Each async step re-checks it and
 * abandons stale work; the previous Room is always fully disconnected before a new one is created,
 * and `this.room` is assigned before connect() so a newer reconcile can tear it down mid-connect.
 */
export class ProximityVoiceClient
{
    private _state: VoiceState = { ...INITIAL_STATE };
    private _generation = 0;
    private _targetRoomId: number | null = null;
    private _room: Room | null = null;
    private _micTrack: LocalAudioTrack | null = null;
    private _micWanted = false;
    private _ticker: ReturnType<typeof setInterval> | null = null;
    private _subscribed = new Set<string>();
    private _gains = new Map<string, number>();
    private _pans = new Map<string, number>();
    private _panners = new Map<string, StereoPannerNode>();
    private _audioContext: AudioContext | null = null;
    private _audioContainer: HTMLDivElement | null = null;
    private _disposed = false;

    constructor(private readonly deps: ProximityVoiceClientDeps)
    {}

    public get state(): VoiceState
    {
        return this._state;
    }

    /** null = not in a room. Idempotent. */
    public setTargetRoom(roomId: number | null): void
    {
        if(this._disposed || (roomId === this._targetRoomId)) return;

        this._targetRoomId = roomId;

        void this.reconcile();
    }

    /** Re-run the connection for the current room (e.g. after an error). */
    public retry(): void
    {
        if(this._disposed) return;

        void this.reconcile();
    }

    /** Effective mic state (mute button and push-to-talk already combined by the caller). */
    public setMicLive(live: boolean): void
    {
        this._micWanted = live;

        void this.applyMicState();
    }

    /** Must be called from a user gesture when state.canPlaybackAudio is false. */
    public async startAudio(): Promise<void>
    {
        try
        {
            if(this._audioContext && (this._audioContext.state !== 'running')) await this._audioContext.resume();
            if(this._room) await this._room.startAudio();
        }
        catch(error)
        {
            this.log('startAudio failed', error);
        }

        this.patchState({ canPlaybackAudio: this._room ? this._room.canPlaybackAudio : true });
    }

    /** Reports a client-side precondition failure (bad/missing pass) without connecting. */
    public fail(error: VoiceErrorCode): void
    {
        this._targetRoomId = null;
        this._generation++;
        void this.teardown().then(() => this.patchState({ status: 'error', error, roomId: null }));
    }

    public dispose(): void
    {
        this._disposed = true;
        this._generation++;
        void this.teardown();

        if(this._audioContext) void this._audioContext.close().catch(() => undefined);
        this._audioContext = null;

        this._audioContainer?.remove();
        this._audioContainer = null;
    }

    private async reconcile(): Promise<void>
    {
        const generation = ++this._generation;
        const isStale = () => (this._disposed || (generation !== this._generation));

        await this.teardown();

        if(isStale()) return;

        const roomId = this._targetRoomId;

        if(roomId === null)
        {
            this.setState({ ...INITIAL_STATE });

            return;
        }

        this.setState({ ...INITIAL_STATE, status: 'connecting', roomId });

        let credentials: VoiceCredentials;

        try
        {
            credentials = await this.deps.fetchCredentials(roomId);
        }
        catch(error)
        {
            if(isStale()) return;

            this.log('token request failed', error);
            this.patchState({ status: 'error', error: ((error instanceof VoiceTokenError) ? error.code : 'token_failed') });

            return;
        }

        if(isStale()) return;

        const room = this.createRoom(generation);

        this._room = room;

        try
        {
            await room.connect(credentials.url, credentials.token, { autoSubscribe: false });
        }
        catch(error)
        {
            if(isStale()) return;

            this.log('livekit connect failed', error);
            await this.teardown();
            this.patchState({ status: 'error', error: 'connect_failed' });

            return;
        }

        if(isStale()) return;

        this.patchState({ status: 'connected', error: null, canPlaybackAudio: room.canPlaybackAudio });

        this._ticker = setInterval(() => this.tick(), this.deps.tickMs);
        this.tick();

        await this.publishMicrophone(room, isStale);
    }

    private createRoom(generation: number): Room
    {
        const audioContext = this.getAudioContext();
        const room = new Room({
            adaptiveStream: false,
            dynacast: false,
            disconnectOnPageLeave: true,
            webAudioMix: (audioContext ? { audioContext } : false),
            audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });

        const isCurrent = () => (!this._disposed && (generation === this._generation) && (this._room === room));

        room
            .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) =>
            {
                if(!isCurrent() || (track.kind !== Track.Kind.Audio)) return;

                this.attachAudio(track as RemoteAudioTrack, participant.identity);
            })
            .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) =>
            {
                track.detach().forEach(element => element.remove());
                this._panners.delete(participant.identity);
            })
            .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) =>
            {
                this._subscribed.delete(participant.identity);
                this._panners.delete(participant.identity);
            })
            .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) =>
            {
                if(!isCurrent()) return;

                this.patchState({ speakingIdentities: speakers.map(speaker => speaker.identity) });
            })
            .on(RoomEvent.AudioPlaybackStatusChanged, () =>
            {
                if(!isCurrent()) return;

                this.patchState({ canPlaybackAudio: room.canPlaybackAudio });
            })
            .on(RoomEvent.Disconnected, (reason?: DisconnectReason) =>
            {
                if(!isCurrent()) return;

                // Unexpected drop of the current room (LiveKit already gave up reconnecting).
                this.log('livekit disconnected', { reason });
                this.stopTicker();
                this._room = null;
                this._micTrack?.stop();
                this._micTrack = null;
                this.patchState({ status: 'error', error: 'disconnected', micPublished: false, micLive: false, speakingIdentities: [] });
            });

        return room;
    }

    private async publishMicrophone(room: Room, isStale: () => boolean): Promise<void>
    {
        if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        {
            this.patchState({ error: 'insecure_context' });

            return;
        }

        let track: LocalAudioTrack;

        try
        {
            track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
        }
        catch(error)
        {
            if(isStale()) return;

            const name = (error as { name?: string })?.name;

            this.log('microphone unavailable', error);
            this.patchState({ error: ((name === 'NotAllowedError' || name === 'SecurityError') ? 'mic_denied' : 'mic_unavailable') });

            return;
        }

        if(isStale())
        {
            track.stop();

            return;
        }

        // Publish muted when we shouldn't be transmitting yet (PTT / muted), so nothing leaks.
        if(!this._micWanted) await track.mute();

        try
        {
            await withTimeout(room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: true, red: true }), PUBLISH_TIMEOUT_MS, 'publishTrack');
        }
        catch(error)
        {
            track.stop();

            if(isStale()) return;

            this.log('publish failed (check that livekit-server is not older than livekit-client)', error);
            this.patchState({ error: 'mic_unavailable' });

            return;
        }

        if(isStale())
        {
            track.stop();

            return;
        }

        this._micTrack = track;
        this.patchState({ micPublished: true });

        await this.applyMicState();
    }

    private async applyMicState(): Promise<void>
    {
        const track = this._micTrack;

        if(!track)
        {
            this.patchState({ micLive: false });

            return;
        }

        try
        {
            if(this._micWanted && track.isMuted) await track.unmute();
            else if(!this._micWanted && !track.isMuted) await track.mute();
        }
        catch(error)
        {
            this.log('mic toggle failed', error);
        }

        this.patchState({ micLive: !track.isMuted });
    }

    private tick(): void
    {
        const room = this._room;
        const roomId = this._state.roomId;

        if(!room || (roomId === null)) return;

        let snapshot: PositionSnapshot;

        try
        {
            snapshot = this.deps.getPositions(roomId);
        }
        catch(error)
        {
            this.log('position snapshot failed', error);

            return;
        }

        const participants = [ ...room.remoteParticipants.values() ];
        const peers = participants.map(participant => ({ id: participant.identity, position: (snapshot.peers.get(participant.identity) ?? null) }));
        const decision = computeProximity(snapshot.self, peers, this._subscribed, this.deps.params, (this.deps.occlusion ?? occlusionFactor));

        this._subscribed = decision.subscribed;
        this._gains = decision.gains;
        this._pans = decision.pans;

        for(const participant of participants)
        {
            const publication = participant.getTrackPublication(Track.Source.Microphone) as RemoteTrackPublication | undefined;

            if(!publication) continue;

            const wanted = decision.subscribed.has(participant.identity);

            if(publication.isDesired !== wanted) publication.setSubscribed(wanted);

            if(wanted && publication.track) this.applyMix(publication.track as RemoteAudioTrack, participant.identity);
        }
    }

    private attachAudio(track: RemoteAudioTrack, identity: string): void
    {
        const context = this.getAudioContext();

        if(this.deps.params.stereoPan && context)
        {
            const panner = context.createStereoPanner();

            this._panners.set(identity, panner);
            track.setWebAudioPlugins([ panner ]);
        }

        // Apply the mix BEFORE the element starts playing, so a new subscription never blasts at full volume.
        this.applyMix(track, identity);

        const element = track.attach();

        this.getAudioContainer().appendChild(element);
    }

    private applyMix(track: RemoteAudioTrack, identity: string): void
    {
        track.setVolume(this._gains.get(identity) ?? 0);

        const panner = this._panners.get(identity);

        if(panner && this._audioContext) panner.pan.setTargetAtTime((this._pans.get(identity) ?? 0), this._audioContext.currentTime, 0.1);
    }

    private async teardown(): Promise<void>
    {
        this.stopTicker();

        const room = this._room;
        const micTrack = this._micTrack;

        this._room = null;
        this._micTrack = null;
        this._subscribed = new Set();
        this._gains = new Map();
        this._pans = new Map();
        this._panners.clear();

        if(room)
        {
            room.remoteParticipants.forEach(participant => participant.audioTrackPublications.forEach(publication => publication.track?.detach().forEach(element => element.remove())));

            try
            {
                await room.disconnect(true);
            }
            catch(error)
            {
                this.log('disconnect failed', error);
            }

            room.removeAllListeners();
        }

        micTrack?.stop();
    }

    private stopTicker(): void
    {
        if(this._ticker) clearInterval(this._ticker);

        this._ticker = null;
    }

    private getAudioContext(): AudioContext | null
    {
        if(this._audioContext) return this._audioContext;

        const Ctor: typeof AudioContext | undefined = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

        if(!Ctor) return null;

        this._audioContext = new Ctor({ latencyHint: 'interactive' });

        return this._audioContext;
    }

    private getAudioContainer(): HTMLDivElement
    {
        if(this._audioContainer && this._audioContainer.isConnected) return this._audioContainer;

        const container = document.createElement('div');

        container.id = 'proximity-voice-audio';
        container.style.display = 'none';
        document.body.appendChild(container);

        this._audioContainer = container;

        return container;
    }

    private setState(state: VoiceState): void
    {
        this._state = state;
        this.deps.onState(state);
    }

    private patchState(patch: Partial<VoiceState>): void
    {
        this.setState({ ...this._state, ...patch });
    }

    private log(message: string, details?: unknown): void
    {
        this.deps.log?.(message, details);
    }
}
