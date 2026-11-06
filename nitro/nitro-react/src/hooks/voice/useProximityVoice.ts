import { NitroLogger, RoomEngineEvent, RoomId, RoomSessionEvent } from '@nitrots/nitro-renderer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBetween } from 'use-between';
import { FetchVoiceCredentials, GetRoomSession, GetSessionDataManager, GetVoiceConfig, GetVoicePass, GetVoicePositionSnapshot, isVoicePassExpired, ProximityVoiceClient, VoiceState } from '../../api';
import { useRoomEngineEvent, useRoomSessionManagerEvent } from '../events';
import { useLocalStorage } from '../useLocalStorage';

const DISABLED_STATE: VoiceState = { status: 'disabled', roomId: null, error: null, micPublished: false, micLive: false, canPlaybackAudio: true, speakingIdentities: [] };

const isEditable = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
    (element instanceof HTMLInputElement) || (element instanceof HTMLTextAreaElement) || ((element as HTMLElement)?.isContentEditable === true);

/**
 * Nitro focuses the chat input on any keydown. The PTT key therefore only acts as PTT while the
 * chat input is empty (or nothing editable is focused); otherwise it types normally.
 */
const shouldHandlePushToTalk = (): boolean =>
{
    const active = document.activeElement;

    if(!isEditable(active)) return true;

    if((active instanceof HTMLInputElement) && active.classList.contains('chat-input')) return (active.value.length === 0);

    return false;
};

const useProximityVoiceState = () =>
{
    const config = useMemo(() => GetVoiceConfig(), []);
    const enabled = (config.enabled && !!config.sidecarUrl);
    const [ state, setState ] = useState<VoiceState>(enabled ? { ...DISABLED_STATE, status: 'idle' } : DISABLED_STATE);
    const [ micEnabled, setMicEnabled ] = useLocalStorage<boolean>('nitro.voice.mic', true);
    const [ pushToTalk, setPushToTalk ] = useLocalStorage<boolean>('nitro.voice.ptt', config.pushToTalkDefault);
    const [ pushToTalkHeld, setPushToTalkHeld ] = useState(false);
    const clientRef = useRef<ProximityVoiceClient>(null);

    const enterRoom = useCallback((roomId: number) =>
    {
        const client = clientRef.current;

        if(!client) return;

        const pass = GetVoicePass();

        if(!pass) return client.fail('no_pass');
        if(isVoicePassExpired(pass)) return client.fail('pass_expired');
        if(pass.userId !== GetSessionDataManager().userId) return client.fail('pass_mismatch');

        client.setTargetRoom(roomId);
    }, []);

    const leaveRoom = useCallback(() => clientRef.current?.setTargetRoom(null), []);

    useEffect(() =>
    {
        if(!enabled) return;

        const client = new ProximityVoiceClient({
            fetchCredentials: roomId =>
            {
                const pass = GetVoicePass();

                return FetchVoiceCredentials(config.sidecarUrl, (pass ? pass.raw : ''), roomId);
            },
            getPositions: GetVoicePositionSnapshot,
            params: {
                hearRadius: config.hearRadius,
                unsubscribeRadius: config.unsubscribeRadius,
                maxSubscriptions: config.maxSubscriptions,
                stereoPan: config.stereoPan,
                panStrength: config.panStrength
            },
            tickMs: config.tickMs,
            onState: setState,
            log: (message, details) => NitroLogger.warn(`[voice] ${ message }`, details)
        });

        clientRef.current = client;

        // Hook mounted while already inside a room (our own avatar is there, i.e. past the door).
        const session = GetRoomSession();

        if(session && GetVoicePositionSnapshot(session.roomId).self) enterRoom(session.roomId);

        return () =>
        {
            client.dispose();
            clientRef.current = null;
        };
    }, [ enabled, config, enterRoom ]);

    const onRoomEngineEvent = useCallback((event: RoomEngineEvent) =>
    {
        if(RoomId.isRoomPreviewerId(event.roomId)) return;

        switch(event.type)
        {
            case RoomEngineEvent.INITIALIZED:
                enterRoom(event.roomId);
                return;
            case RoomEngineEvent.DISPOSED:
                if(clientRef.current && (clientRef.current.state.roomId === event.roomId)) leaveRoom();
                return;
        }
    }, [ enterRoom, leaveRoom ]);

    useRoomEngineEvent<RoomEngineEvent>([ RoomEngineEvent.INITIALIZED, RoomEngineEvent.DISPOSED ], onRoomEngineEvent);
    useRoomSessionManagerEvent<RoomSessionEvent>(RoomSessionEvent.ENDED, leaveRoom);

    // Effective mic = not muted AND (open mic OR PTT held).
    const micLiveWanted = (micEnabled && (!pushToTalk || pushToTalkHeld));

    useEffect(() =>
    {
        clientRef.current?.setMicLive(micLiveWanted);
    }, [ micLiveWanted, state.micPublished ]);

    useEffect(() =>
    {
        if(!enabled || !pushToTalk) return;

        const onKeyDown = (event: KeyboardEvent) =>
        {
            if((event.code !== config.pushToTalkKey) || event.ctrlKey || event.metaKey || event.altKey) return;
            if(!shouldHandlePushToTalk()) return;

            // Capture phase + stop: the chat input never sees the key, so nothing is typed.
            event.preventDefault();
            event.stopImmediatePropagation();

            if(!event.repeat) setPushToTalkHeld(true);
        };

        const onKeyUp = (event: KeyboardEvent) =>
        {
            if(event.code !== config.pushToTalkKey) return;

            setPushToTalkHeld(false);
        };

        // Never leave the mic stuck open when the tab loses focus mid-press.
        const release = () => setPushToTalkHeld(false);
        const onVisibility = () => (document.hidden && release());

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', release);
        document.addEventListener('visibilitychange', onVisibility);

        return () =>
        {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', release);
            document.removeEventListener('visibilitychange', onVisibility);
            setPushToTalkHeld(false);
        };
    }, [ enabled, pushToTalk, config.pushToTalkKey ]);

    const speakingUserIds = useMemo(() => new Set(state.speakingIdentities.map(Number).filter(Number.isFinite)), [ state.speakingIdentities ]);

    const toggleMic = () => setMicEnabled(!micEnabled);
    const togglePushToTalk = () => setPushToTalk(!pushToTalk);
    const startAudio = () => clientRef.current?.startAudio();
    const retry = () =>
    {
        const session = GetRoomSession();

        if(!session || !clientRef.current) return;

        if(clientRef.current.state.roomId === session.roomId) clientRef.current.retry();
        else enterRoom(session.roomId);
    };

    return { config, state, micEnabled, toggleMic, pushToTalk, togglePushToTalk, pushToTalkHeld, speakingUserIds, startAudio, retry };
};

export const useProximityVoice = () => useBetween(useProximityVoiceState);
