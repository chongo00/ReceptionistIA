import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import bodyParser from 'body-parser';
import cors from 'cors';
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
import { setupVoiceWebSocket, isVoiceWebSocketReady, shutdownVoiceWebSocket, getSessionStats } from './realtime/voiceWebSocket.js';
import { isAzureSttConfigured } from './stt/azureSpeechStt.js';
import { setupVoiceLiveTestWebSocket, shutdownVoiceLiveTestWebSocket, isVoiceLiveConfigured } from './realtime/voiceLiveWebSocket.js';
import { isLiveKitConfigured, generateLiveKitToken, selectTransport } from './realtime/livekitTransport.js';
import { createBotSession, closeBotSession, getActiveBotSessionCount } from './webrtc/botParticipant.js';

export async function startServer() {
  const app = express();
  const env = loadEnv();

  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json({ limit: '20mb' }));
  app.use(cors());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (env.voiceSimulatorEnabled) {
    app.use('/test', express.static(path.join(__dirname, '..', 'public')));
  }

  app.get('/health', async (_req, res) => {
    const llmProvider = await getAvailableLlmProvider();
    const sessionStats = getSessionStats();
    res.json({
      ok: true,
      service: 'blindsbook-ia',
      status: 'healthy',
      llm: llmProvider,
      tts: isAzureTtsConfigured() ? 'azure-speech-sdk' : 'none',
      stt: isAzureSttConfigured() ? 'azure-speech-sdk' : 'browser-webspeech',
      ocr: isAzureVisionConfigured() ? 'azure-openai-vision + edge-detection' : 'edge-detection-only',
      voiceWebSocket: isVoiceWebSocketReady() ? 'ready' : 'fallback-http',
      voiceLive: isVoiceLiveConfigured() ? 'configured' : 'not-configured',
      voiceBackend: env.voiceBackend,
      transport: selectTransport(),
      livekitBotSessions: getActiveBotSessionCount(),
      sessions: sessionStats,
    });
  });

  // LiveKit token endpoint — used by browser clients to join a room
  // Also spawns a bot participant that handles the dialogue in the same room.
  app.post('/livekit/token', async (req, res) => {
    if (!isLiveKitConfigured()) {
      res.status(503).json({ error: 'LiveKit not configured' });
      return;
    }
    const roomName = String(req.body?.roomName || `voice-${Date.now()}`);
    const identity = String(req.body?.identity || `user-${Date.now()}`);
    const callId = String(req.body?.callId || roomName);
    try {
      // Generate token for the browser user
      const token = await generateLiveKitToken(roomName, identity);

      // Spawn the server-side bot participant in the same room
      await createBotSession(roomName, callId);

      res.json({ token, wsUrl: env.livekitWsUrl, roomName, callId });
    } catch (err) {
      console.error('[LiveKit] Token generation / bot session error:', err);
      res.status(500).json({ error: 'Failed to generate token or create bot session' });
    }
  });

  // LiveKit session close endpoint
  app.post('/livekit/close', async (req, res) => {
    const callId = String(req.body?.callId || '');
    if (!callId) {
      res.status(400).json({ error: 'callId required' });
      return;
    }
    await closeBotSession(callId);
    res.json({ ok: true });
  });

  // Serves temporary TTS audio files
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
      const cfg = env.phoneToCompanyMap.get(toNumber);
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
          console.error('DEBUG: error creando cita en BlindsBook:', err);
        }
      } else {
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
      companyPhone: string;
    }

    const results: LookupResult[] = [];
    const companiesSearched: number[] = [];

    for (const [companyPhone, cfg] of env.phoneToCompanyMap) {
      companiesSearched.push(cfg.companyId);
      try {
        setTokenForCompany(cfg);
        const matches = await findCustomersByPhone(phone);
        for (const match of matches) {
          results.push({
            ...match,
            companyId: cfg.companyId,
            companyPhone,
          });
        }
      } catch (err) {
        console.warn(`customer-lookup: error buscando en compañía ${cfg.companyId}:`, err);
      }
    }

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
      const cfg = env.phoneToCompanyMap.get(toNumber);
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
      // Tier 1: Azure OpenAI Vision (GPT-4o) for higher accuracy
      if (isAzureVisionConfigured()) {
        const visionResult = await detectWindowFrameWithVision(image, Number(width), Number(height));
        if (visionResult) {
          res.json(visionResult);
          return;
        }
        console.warn('[OCR] Azure Vision returned no result, falling back to edge detection');
      }

      // Tier 2: Edge detection fallback (sharp + Laplacian)
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

  try {
    await initTokenManager();
  } catch (err) {
    console.error('[Auth] Error inicializando TokenManager (continuando sin auto-login):', err);
  }

  const port = Number(process.env.PORT || 4000);
  const httpServer = createServer(app);
  const voiceWss = setupVoiceWebSocket(httpServer);
  const voiceLiveWss = setupVoiceLiveTestWebSocket(httpServer);

  // Manual upgrade routing: both WSS use noServer mode so we dispatch by path
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws/voice') {
      voiceWss.handleUpgrade(request, socket, head, (ws) => {
        voiceWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/voice-live-test') {
      voiceLiveWss.handleUpgrade(request, socket, head, (ws) => {
        voiceLiveWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`🚗 Servicio IA recepcionista escuchando en puerto ${port}`);
      console.log(`📞 WebSocket de voz disponible en ws://localhost:${port}/ws/voice`);
      if (isAzureSttConfigured()) {
        console.log('✅ Azure Speech SDK configurado (STT + TTS profesional)');
      } else {
        console.log('⚠️ Azure Speech no configurado - usando fallback del navegador para STT');
      }
      if (isVoiceLiveConfigured()) {
        console.log(`✅ Voice Live API configurada (test: ws://localhost:${port}/ws/voice-live-test)`);
      } else {
        console.log(`⚠️ Voice Live no configurado (VOICE_LIVE_*); /ws/voice-live-test acepta conexión pero fallará en init`);
      }
      console.log(`📋 Voice backend: ${env.voiceBackend}`);
      console.log(`🔗 Transport: ${selectTransport()}${isLiveKitConfigured() ? ' (LiveKit WebRTC)' : ' (WebSocket fallback)'}`);
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[Server] ${signal} received — graceful shutdown...`);
    await shutdownVoiceWebSocket();
    shutdownVoiceLiveTestWebSocket();
    httpServer.close(() => {
      console.log('[Server] HTTP server closed');
      process.exit(0);
    });
    // Force exit after 10s if graceful close hangs
    setTimeout(() => { console.error('[Server] Forced exit after timeout'); process.exit(1); }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
