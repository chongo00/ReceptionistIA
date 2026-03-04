export interface CompanyMapEntry {
  companyId: number;
  email?: string;
  password?: string;
  token?: string;
}

export interface EnvConfig {
  port: number;
  twilioAuthToken: string;
  twilioValidateSignature: boolean;
  blindsbookApiBaseUrl: string;
  blindsbookApiToken: string;
  blindsbookLoginEmail: string | null;
  blindsbookLoginPassword: string | null;
  twilioNumberToCompanyMap: Map<string, CompanyMapEntry>;
  publicBaseUrl: string | null;
  azureSpeechKey: string | null;
  azureSpeechRegion: string | null;
  azureTtsVoiceEs: string | null;
  azureTtsVoiceEn: string | null;
  azureOpenaiEndpoint: string | null;
  azureOpenaiApiKey: string | null;
  azureOpenaiDeployment: string | null;
  azureOpenaiApiVersion: string;
}

let _cached: EnvConfig | null = null;

export function loadEnv(): EnvConfig {
  if (_cached) return _cached;

  const twilioNumberToCompanyMap = new Map<string, CompanyMapEntry>();
  const mapJson = process.env.TWILIO_NUMBER_TO_COMPANY_MAP;
  if (mapJson) {
    try {
      const parsed = JSON.parse(mapJson) as Record<string, CompanyMapEntry>;
      for (const [number, config] of Object.entries(parsed)) {
        twilioNumberToCompanyMap.set(number, config);
      }
    } catch {
      console.warn('TWILIO_NUMBER_TO_COMPANY_MAP has invalid JSON format');
    }
  }

  _cached = {
    port: Number(process.env.PORT || 4000),
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioValidateSignature: process.env.TWILIO_VALIDATE_SIGNATURE !== 'false',
    blindsbookApiBaseUrl: process.env.BLINDSBOOK_API_BASE_URL || 'http://localhost:3000',
    blindsbookApiToken: process.env.BLINDSBOOK_API_TOKEN || '',
    blindsbookLoginEmail: process.env.BLINDSBOOK_LOGIN_EMAIL || null,
    blindsbookLoginPassword: process.env.BLINDSBOOK_LOGIN_PASSWORD || null,
    twilioNumberToCompanyMap,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
    azureSpeechKey: process.env.AZURE_SPEECH_KEY || null,
    azureSpeechRegion: process.env.AZURE_SPEECH_REGION || null,
    azureTtsVoiceEs: process.env.AZURE_TTS_VOICE_ES || null,
    azureTtsVoiceEn: process.env.AZURE_TTS_VOICE_EN || null,
    azureOpenaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || null,
    azureOpenaiApiKey: process.env.AZURE_OPENAI_API_KEY || null,
    azureOpenaiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || null,
    azureOpenaiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
  };

  return _cached;
}
