export interface EnvConfig {
  port: number;
  twilioAuthToken: string;
  twilioValidateSignature: boolean;
  blindsbookApiBaseUrl: string;
  blindsbookApiToken: string;
  blindsbookLoginEmail: string | null;
  blindsbookLoginPassword: string | null;
  twilioNumberToCompanyMap: Map<string, { token: string; companyId: number }>;
  aiServiceUrl: string | null;
  aiServiceApiKey: string | null;
}

export function loadEnv(): EnvConfig {
  const port = Number(process.env.PORT || 4000);

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
  const blindsbookApiBaseUrl =
    process.env.BLINDSBOOK_API_BASE_URL || 'http://localhost:3000';
  const blindsbookApiToken = process.env.BLINDSBOOK_API_TOKEN || '';

  const blindsbookLoginEmail = process.env.BLINDSBOOK_LOGIN_EMAIL || null;
  const blindsbookLoginPassword = process.env.BLINDSBOOK_LOGIN_PASSWORD || null;

  // Mapping: número Twilio → { token, companyId }
  // Formato JSON: {"+1234567890":{"token":"...","companyId":1},"+0987654321":{"token":"...","companyId":2}}
  const twilioNumberToCompanyMap = new Map<string, { token: string; companyId: number }>();
  const mapJson = process.env.TWILIO_NUMBER_TO_COMPANY_MAP;
  if (mapJson) {
    try {
      const parsed = JSON.parse(mapJson) as Record<string, { token: string; companyId: number }>;
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
  };
}

