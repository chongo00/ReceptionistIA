export interface CompanyMapEntry {
  companyId: number;
  email?: string;
  password?: string;
  token?: string;
}

export interface EnvConfig {
  port: number;
  blindsbookApiBaseUrl: string;
  blindsbookApiToken: string;
  blindsbookLoginEmail: string | null;
  blindsbookLoginPassword: string | null;
  /** Mapeo de número de teléfono → compañía (PHONE_TO_COMPANY_MAP). */
  phoneToCompanyMap: Map<string, CompanyMapEntry>;
  publicBaseUrl: string | null;
  azureSpeechKey: string | null;
  azureSpeechRegion: string | null;
  azureTtsVoiceEs: string | null;
  azureTtsVoiceEn: string | null;
  azureOpenaiEndpoint: string | null;
  azureOpenaiApiKey: string | null;
  azureOpenaiDeployment: string | null;
  azureOpenaiApiVersion: string;
  voiceSimulatorEnabled: boolean;
  maxConcurrentSessions: number;
  maxConcurrentTts: number;
  // Voice Live API
  voiceLiveEndpoint: string | null;
  voiceLiveApiKey: string | null;
  voiceLiveModel: string | null;
  voiceLiveApiVersion: string;
  voiceBackend: 'local' | 'voice_live';
}

let _cached: EnvConfig | null = null;

export function loadEnv(): EnvConfig {
  if (_cached) return _cached;

  const phoneToCompanyMap = new Map<string, CompanyMapEntry>();
  const mapJson = process.env.PHONE_TO_COMPANY_MAP;
  if (mapJson) {
    try {
      const parsed = JSON.parse(mapJson) as Record<string, CompanyMapEntry>;
      for (const [number, config] of Object.entries(parsed)) {
        phoneToCompanyMap.set(number, config);
      }
    } catch {
      console.warn('PHONE_TO_COMPANY_MAP has invalid JSON format');
    }
  }

  _cached = {
    port: Number(process.env.PORT || 4000),
    blindsbookApiBaseUrl: process.env.BLINDSBOOK_API_BASE_URL || 'http://localhost:3000',
    blindsbookApiToken: process.env.BLINDSBOOK_API_TOKEN || '',
    blindsbookLoginEmail: process.env.BLINDSBOOK_LOGIN_EMAIL || null,
    blindsbookLoginPassword: process.env.BLINDSBOOK_LOGIN_PASSWORD || null,
    phoneToCompanyMap,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
    azureSpeechKey: process.env.AZURE_SPEECH_KEY || null,
    azureSpeechRegion: process.env.AZURE_SPEECH_REGION || null,
    azureTtsVoiceEs: process.env.AZURE_TTS_VOICE_ES || null,
    azureTtsVoiceEn: process.env.AZURE_TTS_VOICE_EN || null,
    azureOpenaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || null,
    azureOpenaiApiKey: process.env.AZURE_OPENAI_API_KEY || null,
    azureOpenaiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || null,
    azureOpenaiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    voiceSimulatorEnabled: process.env.VOICE_SIMULATOR_ENABLED !== 'false',
    maxConcurrentSessions: Number(process.env.MAX_CONCURRENT_SESSIONS || 20),
    maxConcurrentTts: Number(process.env.MAX_CONCURRENT_TTS || 25),
    voiceLiveEndpoint: process.env.VOICE_LIVE_ENDPOINT || null,
    voiceLiveApiKey: process.env.VOICE_LIVE_API_KEY || null,
    voiceLiveModel: process.env.VOICE_LIVE_MODEL || null,
    voiceLiveApiVersion: process.env.VOICE_LIVE_API_VERSION || '2025-10-01',
    voiceBackend: (process.env.VOICE_BACKEND === 'voice_live' ? 'voice_live' : 'local') as 'local' | 'voice_live',
  };

  return _cached;
}

export function isVoiceLiveConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.voiceLiveEndpoint && env.voiceLiveApiKey && env.voiceLiveModel);
}
