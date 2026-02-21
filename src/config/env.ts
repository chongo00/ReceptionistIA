export interface CompanyMapEntry {
  companyId: number;
  /** Credenciales para auto-login (recomendado — el token se renueva solo) */
  email?: string;
  password?: string;
  /** Token estático (fallback si no hay credenciales — expira en 24h) */
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
  aiServiceUrl: string | null;
  aiServiceApiKey: string | null;
  publicBaseUrl: string | null;
  azureSpeechKey: string | null;
  azureSpeechRegion: string | null;
  azureTtsVoiceEs: string | null;
  azureTtsVoiceEn: string | null;
  /** URL del contenedor Docker BlindsBook-IA (Piper TTS + OCR). Ej: http://localhost:8000 */
  dockerTtsUrl: string | null;
  /** URL de Ollama (Mini LLM local). Ej: http://localhost:11434 */
  ollamaUrl: string | null;
  /** Modelo de Ollama a usar. Ej: qwen2.5:3b */
  ollamaModel: string;
}

export function loadEnv(): EnvConfig {
  const port = Number(process.env.PORT || 4000);

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
  const blindsbookApiBaseUrl =
    process.env.BLINDSBOOK_API_BASE_URL || 'http://localhost:3000';
  const blindsbookApiToken = process.env.BLINDSBOOK_API_TOKEN || '';

  const blindsbookLoginEmail = process.env.BLINDSBOOK_LOGIN_EMAIL || null;
  const blindsbookLoginPassword = process.env.BLINDSBOOK_LOGIN_PASSWORD || null;

  // Mapping: número Twilio → { companyId, email, password } o { companyId, token }
  // Formato JSON con credenciales (RECOMENDADO — auto-renueva tokens):
  //   {"+1234567890":{"companyId":1,"email":"user@co.com","password":"pass"}}
  // Formato legacy con token estático (expira en 24h):
  //   {"+1234567890":{"token":"jwt...","companyId":1}}
  const twilioNumberToCompanyMap = new Map<string, CompanyMapEntry>();
  const mapJson = process.env.TWILIO_NUMBER_TO_COMPANY_MAP;
  if (mapJson) {
    try {
      const parsed = JSON.parse(mapJson) as Record<string, CompanyMapEntry>;
      for (const [number, config] of Object.entries(parsed)) {
        twilioNumberToCompanyMap.set(number, config);
      }
    } catch {
      // eslint-disable-next-line no-console
      console.warn('TWILIO_NUMBER_TO_COMPANY_MAP tiene formato JSON inválido');
    }
  }

  const aiServiceUrl = process.env.AI_SERVICE_URL || null;
  const aiServiceApiKey = process.env.AI_SERVICE_API_KEY || null;

  // Para que Twilio pueda hacer GET a /tts/... desde internet (ngrok/azure)
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || null;

  // Azure Speech (TTS neuronal)
  const azureSpeechKey = process.env.AZURE_SPEECH_KEY || null;
  const azureSpeechRegion = process.env.AZURE_SPEECH_REGION || null;
  const azureTtsVoiceEs = process.env.AZURE_TTS_VOICE_ES || null;
  const azureTtsVoiceEn = process.env.AZURE_TTS_VOICE_EN || null;

  // Docker BlindsBook-IA (Piper TTS local, OCR, STT)
  const dockerTtsUrl = process.env.DOCKER_TTS_URL || null;

  // Ollama (Mini LLM local para identificación de clientes)
  const ollamaUrl = process.env.OLLAMA_URL || null;
  const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

  return {
    port,
    twilioAuthToken,
    twilioValidateSignature:
      process.env.TWILIO_VALIDATE_SIGNATURE !== 'false',
    blindsbookApiBaseUrl,
    blindsbookApiToken,
    blindsbookLoginEmail,
    blindsbookLoginPassword,
    twilioNumberToCompanyMap,
    aiServiceUrl,
    aiServiceApiKey,
    publicBaseUrl,
    azureSpeechKey,
    azureSpeechRegion,
    azureTtsVoiceEs,
    azureTtsVoiceEn,
    dockerTtsUrl,
    ollamaUrl,
    ollamaModel,
  };
}

