import { GetConfiguration } from '../nitro';
import { resolveVoiceConfig, VoiceConfig } from './VoiceConfig';

let cached: VoiceConfig = null;

/** Defaults from VoiceConfig.ts, overridden by the "voice" object in ui-config.json. */
export const GetVoiceConfig = (): VoiceConfig =>
{
    if(!cached) cached = resolveVoiceConfig(GetConfiguration<Record<string, unknown>>('voice', null));

    return cached;
};
