import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import bodyParser from 'body-parser';
import cors from 'cors';
import { twilioVoiceRouter } from './twilio/voiceWebhook.js';
import { handleUserInput, getConversationState, setConversationState, clearConversationState } from './dialogue/manager.js';
import { loadEnv } from './config/env.js';
import { setTokenForCompany, clearTokenOverride, createAppointment, initTokenManager, findCustomersByPhone } from './blindsbook/appointmentsClient.js';
import type { CreateAppointmentPayload } from './models/appointments.js';
import { getAudio } from './tts/ttsCache.js';
import { synthesizeTts } from './tts/ttsProvider.js';
import { getAvailableLlmProvider } from './llm/llmClient.js';
import { isAzureTtsConfigured } from './tts/azureNeuralTts.js';
import { detectWindowFrame } from './ocr/windowFrameDetector.js';
import { detectWindowFrameWithVision, isAzureVisionConfigured } from './ocr/azureVisionOcr.js';
import { setupVoiceWebSocket, isVoiceWebSocketReady } from './realtime/voiceWebSocket.js';
import { isAzureSttConfigured } from './stt/azureSpeechStt.js';

export async function startServer() {
  const app = express();
  const env = loadEnv();

  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json({ limit: '20mb' })); // 20 MB for base64 OCR images
  app.use(cors());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use('/test', express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', async (_req, res) => {
    const llmProvider = await getAvailableLlmProvider();
    res.json({
      ok: true,
      service: 'blindsbook-ia',
      status: 'healthy',
      llm: llmProvider,    // 'azure-openai' | 'ollama' | 'none'
      tts: isAzureTtsConfigured() ? 'azure-speech-sdk' : 'twilio-say-fallback',
      stt: isAzureSttConfigured() ? 'azure-speech-sdk' : 'browser-webspeech',
      ocr: isAzureVisionConfigured() ? 'azure-openai-vision + edge-detection' : 'edge-detection-only',
      voiceWebSocket: isVoiceWebSocketReady() ? 'ready' : 'fallback-http',
    });
  });

  // Temporary TTS audio for Twilio <Play/>
  app.get('/tts/:id.mp3', (req, res) => {
    const id = String(req.params.id || '');
    const audio = getAudio(id);
    if (!audio) {
      res.status(404).send('not_found');
      return;
    }
    res.setHeader('Content-Type', audio.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(audio.bytes);
  });

  app.post('/debug/chat', async (req, res) => {
    const callId = String(req.body?.callId || 'local-test');
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const toNumber = typeof req.body?.toNumber === 'string' ? req.body.toNumber : null;
    const fromNumber = typeof req.body?.fromNumber === 'string' ? req.body.fromNumber : null;

    if (toNumber) {
      const cfg = env.twilioNumberToCompanyMap.get(toNumber);
      if (cfg) setTokenForCompany(cfg);
    } else {
      clearTokenOverride();
    }

    if (fromNumber) {
      const existingState = getConversationState(callId);
      if (!existingState.callerPhone) {
        existingState.callerPhone = fromNumber;
        setConversationState(callId, existingState);
      }
    }

    const result = await handleUserInput(callId, text);

    if (result.state.step === 'creatingAppointment' && result.state.type !== null) {
      const now = new Date();
      const isoNow = now.toISOString();

      if (result.state.customerId) {
        const payload: CreateAppointmentPayload = {
          customerId: result.state.customerId,
          type: result.state.type,
          startDate: result.state.startDateISO ?? isoNow,
          duration: result.state.duration ?? '01:00:00',
          status: result.state.status,
          userId: result.state.userId ?? undefined,
          saleOrderId: result.state.saleOrderId ?? undefined,
          installationContactId: result.state.installationContactId ?? undefined,
          remarks: result.state.remarks ?? undefined,
        };

        try {
          await createAppointment(payload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('DEBUG: error creando cita en BlindsBook:', err);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn('DEBUG: no se crea cita porque customerId es null');
      }
    }
    
    if (result.isFinished) {
      clearConversationState(callId);
    } else {
      setConversationState(callId, result.state);
    }

    res.json(result);
  });

  // ─── Customer lookup by phone (searches across all configured companies) ───
  app.get('/debug/customer-lookup', async (req, res) => {
    const phone = String(req.query.phone || '').trim();
    if (!phone || phone.length < 3) {
      res.status(400).json({ success: false, error: 'Se requiere parámetro "phone" (mínimo 3 caracteres)' });
      return;
    }

    interface LookupResult {
      id: number;
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      phone: string | null;
      accountManagerId: number | null;
      companyId: number;
      twilioNumber: string;
    }

    const results: LookupResult[] = [];
    const companiesSearched: number[] = [];

    for (const [twilioNumber, cfg] of env.twilioNumberToCompanyMap) {
      companiesSearched.push(cfg.companyId);
      try {
        setTokenForCompany(cfg);
        const matches = await findCustomersByPhone(phone);
        for (const match of matches) {
          results.push({
            ...match,
            companyId: cfg.companyId,
            twilioNumber,
          });
        }
      } catch (err) {
        console.warn(`customer-lookup: error buscando en compañía ${cfg.companyId}:`, err);
      }
    }

    // Restore default
    clearTokenOverride();

    res.json({
      success: true,
      phone,
      companiesSearched,
      totalResults: results.length,
      results,
    });
  });

  app.post('/debug/voice-chat', async (req, res) => {
    const callId = String(req.body?.callId || 'voice-test');
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const toNumber = typeof req.body?.toNumber === 'string' ? req.body.toNumber : null;
    const fromNumber = typeof req.body?.fromNumber === 'string' ? req.body.fromNumber : null;

    if (toNumber) {
      const cfg = env.twilioNumberToCompanyMap.get(toNumber);
      if (cfg) setTokenForCompany(cfg);
    } else {
      clearTokenOverride();
    }

    if (fromNumber) {
      const existingState = getConversationState(callId);
      if (!existingState.callerPhone) {
        existingState.callerPhone = fromNumber;
        setConversationState(callId, existingState);
      }
    }

    const result = await handleUserInput(callId, text);

    if (result.state.step === 'creatingAppointment' && result.state.type !== null && result.state.customerId) {
      const payload: CreateAppointmentPayload = {
        customerId: result.state.customerId,
        type: result.state.type,
        startDate: result.state.startDateISO ?? new Date().toISOString(),
        duration: result.state.duration ?? '01:00:00',
        status: result.state.status,
        userId: result.state.userId ?? undefined,
        saleOrderId: result.state.saleOrderId ?? undefined,
        installationContactId: result.state.installationContactId ?? undefined,
        remarks: result.state.remarks ?? undefined,
      };
      try { await createAppointment(payload); } catch (err) {
        console.error('VOICE-CHAT: error creando cita:', err);
      }
    }

    if (result.isFinished) {
      clearConversationState(callId);
    } else {
      setConversationState(callId, result.state);
    }

    let ttsProvider: string = 'none';
    let audioUrl: string | null = null;
    let audioBase64: string | null = null;
    try {
      const lang = result.state.language === 'en' ? 'en' : 'es' as const;
      const ttsResult = await synthesizeTts(result.replyText, lang);
      if (ttsResult) {
        ttsProvider = ttsResult.provider;
        const { putAudio } = await import('./tts/ttsCache.js');
        const id = putAudio(ttsResult.bytes, ttsResult.contentType, 10 * 60);
        audioUrl = `/tts/${id}.mp3`;
        audioBase64 = ttsResult.bytes.toString('base64');
      }
    } catch (err) {
      console.warn('VOICE-CHAT: TTS falló:', err);
    }

    res.json({
      replyText: result.replyText,
      state: result.state,
      isFinished: result.isFinished,
      ttsProvider,
      audioUrl,
      audioBase64,
    });
  });

  app.get('/debug/play-audio', async (req, res) => {
    const text = String(req.query.text || 'Hola, soy la recepcionista de BlindsBook.');
    const lang = String(req.query.lang || 'es') as 'es' | 'en';

    try {
      const ttsResult = await synthesizeTts(text, lang);
      if (ttsResult) {
        res.setHeader('Content-Type', ttsResult.contentType);
        res.setHeader('X-TTS-Provider', ttsResult.provider);
        res.send(ttsResult.bytes);
        return;
      }
    } catch (err) {
      console.warn('play-audio TTS error:', err);
    }
    res.status(503).json({ error: 'No TTS provider available' });
  });

  app.post('/ocr/window-frame', async (req, res) => {
    const { image, width, height } = req.body ?? {};
    if (!image || typeof image !== 'string' || !width || !height) {
      res.status(400).json({ error: 'missing_fields', message: 'Required: image (base64), width, height' });
      return;
    }
    try {
      // Tier 1: Azure OpenAI Vision (GPT-4o) — high accuracy
      if (isAzureVisionConfigured()) {
        const visionResult = await detectWindowFrameWithVision(image, Number(width), Number(height));
        if (visionResult) {
          res.json(visionResult);
          return;
        }
        console.warn('[OCR] Azure Vision returned no result, falling back to edge detection');
      }

      // Tier 2: Edge detection (sharp + Laplacian)
      const result = await detectWindowFrame(image, Number(width), Number(height));
      if (!result) {
        res.json({ error: 'no_window', message: 'No window frame detected' });
        return;
      }
      res.json(result);
    } catch (err) {
      console.error('OCR window-frame error:', err);
      res.status(500).json({ error: 'processing_error', message: 'Failed to process image' });
    }
  });

  app.use('/twilio', twilioVoiceRouter);

  try {
    await initTokenManager();
  } catch (err) {
    console.error('[Auth] Error inicializando TokenManager (continuando sin auto-login):', err);
  }

  const port = Number(process.env.PORT || 4000);

  // Create HTTP server and attach WebSocket
  const httpServer = createServer(app);
  
  // Setup WebSocket for real-time voice communication
  setupVoiceWebSocket(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`🚗 Servicio IA recepcionista escuchando en puerto ${port}`);
      console.log(`📞 WebSocket de voz disponible en ws://localhost:${port}/ws/voice`);
      if (isAzureSttConfigured()) {
        console.log('✅ Azure Speech SDK configurado (STT + TTS profesional)');
      } else {
        console.log('⚠️ Azure Speech no configurado - usando fallback del navegador para STT');
      }
      resolve();
    });
  });
}

