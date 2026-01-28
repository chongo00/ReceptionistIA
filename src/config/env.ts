export interface EnvConfig {
  port: number;
  twilioAuthToken: string;
  twilioValidateSignature: boolean;
  blindsbookApiBaseUrl: string;
  blindsbookApiToken: string;
  blindsbookLoginEmail: string | null;
  blindsbookLoginPassword: string | null;
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
    aiServiceUrl,
    aiServiceApiKey,
  };
}

