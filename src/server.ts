import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import cors from 'cors';
import { twilioVoiceRouter } from './twilio/voiceWebhook.js';
import { handleUserInput, getConversationState, setConversationState, clearConversationState } from './dialogue/manager.js';
import { loadEnv } from './config/env.js';
import { setTokenForCompany, clearTokenOverride, createAppointment } from './blindsbook/appointmentsClient.js';
import type { CreateAppointmentPayload } from './models/appointments.js';
import { getAudio } from './tts/ttsCache.js';
import { synthesizeTts } from './tts/ttsProvider.js';
import { isOllamaAvailable } from './llm/ollamaClient.js';

export async function startServer() {
  const app = express();
  const env = loadEnv();

  // Twilio envía datos como application/x-www-form-urlencoded por defecto
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());
  app.use(cors()); // CORS abierto para pruebas locales

  // Servir páginas estáticas (ej. /test/voice-test.html)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use('/test', express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', async (_req, res) => {
    const ollamaOk = await isOllamaAvailable();
    res.json({
      ok: true,
      service: 'blindsbook-ia',
      status: 'healthy',
      ollama: ollamaOk ? 'connected' : 'unavailable',
    });
  });

  // Audio TTS temporal (para Twilio <Play/>). Se llena desde el webhook al sintetizar.
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

  // Modo 100% local/gratis (sin Twilio): simula turnos de conversación.
  // POST /debug/chat { callId: "test", text: "hola", toNumber: "+123...", fromNumber: "+1555..." }
  app.post('/debug/chat', async (req, res) => {
    const callId = String(req.body?.callId || 'local-test');
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const toNumber = typeof req.body?.toNumber === 'string' ? req.body.toNumber : null;
    const fromNumber = typeof req.body?.fromNumber === 'string' ? req.body.fromNumber : null;

    // Permite probar multi-tenant en local simulando el número Twilio (To)
    if (toNumber) {
      const cfg = env.twilioNumberToCompanyMap.get(toNumber);
      if (cfg) setTokenForCompany(cfg.token);
    } else {
      clearTokenOverride();
    }

    // Guardar Caller ID (From) en el state para identificación automática
    if (fromNumber) {
      const existingState = getConversationState(callId);
      if (!existingState.callerPhone) {
        existingState.callerPhone = fromNumber;
        setConversationState(callId, existingState);
      }
    }

    const result = await handleUserInput(callId, text);

    // En modo debug, si llegamos al paso de creación, intentamos crear la cita realmente
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
    
    // Guardar estado entre turnos (igual que en el webhook de Twilio)
    if (result.isFinished) {
      clearConversationState(callId);
    } else {
      setConversationState(callId, result.state);
    }
    
    res.json(result);
  });

  // ──────────── /debug/voice-chat ────────────
  // Igual que /debug/chat pero devuelve AUDIO MP3 listo para reproducir en el navegador.
  // POST { callId, text, toNumber?, fromNumber? }
  // Response: { replyText, state, isFinished, ttsProvider, audioUrl }
  //   audioUrl → GET /tts/<id>.mp3 (disponible 10 min)
  //   También devuelve audioBase64 para reproducción inline.
  app.post('/debug/voice-chat', async (req, res) => {
    const callId = String(req.body?.callId || 'voice-test');
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const toNumber = typeof req.body?.toNumber === 'string' ? req.body.toNumber : null;
    const fromNumber = typeof req.body?.fromNumber === 'string' ? req.body.fromNumber : null;

    if (toNumber) {
      const cfg = env.twilioNumberToCompanyMap.get(toNumber);
      if (cfg) setTokenForCompany(cfg.token);
    } else {
      clearTokenOverride();
    }

    // Guardar Caller ID (From) en el state para identificación automática
    if (fromNumber) {
      const existingState = getConversationState(callId);
      if (!existingState.callerPhone) {
        existingState.callerPhone = fromNumber;
        setConversationState(callId, existingState);
      }
    }

    const result = await handleUserInput(callId, text);

    // Crear cita si corresponde
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

    // Guardar estado
    if (result.isFinished) {
      clearConversationState(callId);
    } else {
      setConversationState(callId, result.state);
    }

    // Sintetizar audio TTS
    let ttsProvider: string = 'none';
    let audioUrl: string | null = null;
    let audioBase64: string | null = null;
    try {
      const lang = result.state.language === 'en' ? 'en' : 'es' as const;
      const ttsResult = await synthesizeTts(result.replyText, lang);
      if (ttsResult) {
        ttsProvider = ttsResult.provider;
        // Guardar en cache para servir por URL
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

  // ──────────── /debug/play-audio ────────────
  // GET endpoint simple: pasa texto y devuelve MP3 directo para el navegador.
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

  app.use('/twilio', twilioVoiceRouter);

  const port = Number(process.env.PORT || 4000);

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`🚗 Servicio IA recepcionista escuchando en puerto ${port}`);
      resolve();
    });
  });
}

