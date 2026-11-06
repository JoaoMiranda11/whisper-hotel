import { FC } from 'react';
import { FaMicrophone, FaMicrophoneSlash, FaVolumeUp } from 'react-icons/fa';
import { VoiceErrorCode } from '../../../../api';
import { Base, classNames, Flex, Text } from '../../../../common';
import { useProximityVoice } from '../../../../hooks';
import { UserLocationView } from '../user-location/UserLocationView';

const ERROR_MESSAGES: Record<VoiceErrorCode, string> = {
    insecure_context: 'Sem HTTPS: microfone indisponível (só ouvindo).',
    mic_denied: 'Permissão de microfone negada (só ouvindo).',
    mic_unavailable: 'Microfone indisponível (só ouvindo).',
    no_pass: 'Link de entrada sem passe de voz.',
    pass_expired: 'Passe de voz expirado. Peça um link novo.',
    pass_mismatch: 'Passe de voz é de outro usuário.',
    unauthorized: 'Passe de voz recusado pelo servidor.',
    token_failed: 'Servidor de voz indisponível.',
    connect_failed: 'Falha ao conectar na voz.',
    disconnected: 'Voz desconectada.'
};

const keyLabel = (code: string): string => code.replace(/^Key/, '').replace(/^Digit/, '');

export const VoiceWidgetView: FC<{}> = props =>
{
    const { config, state, micEnabled, toggleMic, pushToTalk, togglePushToTalk, pushToTalkHeld, speakingUserIds, startAudio, retry } = useProximityVoice();

    if(state.status === 'disabled') return null;

    const isError = (state.status === 'error');
    const micTitle = (!state.micPublished ? 'Microfone indisponível' : (micEnabled ? 'Silenciar microfone' : 'Ativar microfone'));

    return (
        <>
            { [ ...speakingUserIds ].map(userId =>
                <UserLocationView key={ userId } userId={ userId } className="nitro-voice-speaking-location">
                    <Base className="nitro-voice-speaking-indicator">
                        <FaVolumeUp />
                    </Base>
                </UserLocationView>) }
            <Flex className="nitro-voice-widget" gap={ 1 } alignItems="center">
                <Base className={ classNames('nitro-voice-status', `status-${ state.status }`) } title={ state.status } />
                <Base
                    pointer
                    className={ classNames('nitro-voice-button', (!micEnabled && 'muted'), state.micLive && 'live', !state.micPublished && 'unavailable') }
                    title={ micTitle }
                    onClick={ toggleMic }>
                    { (micEnabled && state.micPublished) ? <FaMicrophone /> : <FaMicrophoneSlash /> }
                </Base>
                <Base
                    pointer
                    className={ classNames('nitro-voice-button', 'ptt', pushToTalk && 'active', pushToTalkHeld && 'live') }
                    title={ pushToTalk ? `Push-to-talk ligado: segure ${ keyLabel(config.pushToTalkKey) }` : 'Ligar push-to-talk' }
                    onClick={ togglePushToTalk }>
                    <Text small bold variant="white">{ pushToTalk ? `PTT ${ keyLabel(config.pushToTalkKey) }` : 'PTT' }</Text>
                </Base>
                { !state.canPlaybackAudio &&
                    <Base pointer className="nitro-voice-button attention" onClick={ startAudio }>
                        <Text small bold variant="white">Ativar áudio</Text>
                    </Base> }
                { state.error &&
                    <Text small variant="white" className="nitro-voice-error">{ ERROR_MESSAGES[state.error] }</Text> }
                { isError && (state.error !== 'no_pass') && (state.error !== 'pass_expired') && (state.error !== 'pass_mismatch') &&
                    <Base pointer className="nitro-voice-button" onClick={ retry }>
                        <Text small bold variant="white">Tentar de novo</Text>
                    </Base> }
            </Flex>
        </>
    );
};
