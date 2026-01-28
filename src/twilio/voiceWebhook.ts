import express from 'express';
import { twiml as Twiml } from 'twilio';
import { handleUserInput, setConversationState, clearConversationState } from '../dialogue/manager.js';
import { loadEnv } from '../config/env.js';
import { createAppointment } from '../blindsbook/appointmentsClient.js';
import type { CreateAppointmentPayload } from '../models/appointments.js';

export const twilioVoiceRouter = express.Router();

const env = loadEnv();

twilioVoiceRouter.post('/voice-webhook', async (req, res) => {
  const callId = String(req.body.CallSid || '');
  const fromNumber = typeof req.body.From === 'string' ? req.body.From : null;
  const digits = typeof req.body.Digits === 'string' ? req.body.Digits : null;
  const speechResult =
    typeof req.body.SpeechResult === 'string' ? req.body.SpeechResult : null;

  // Para este esqueleto usamos SpeechResult si existe, si no Digits, si no null.
  let userText = speechResult || digits;
  // Si el sistema está preguntando por el cliente y no hay input, intentamos usar Caller ID.
  if (!userText && fromNumber) {
    userText = fromNumber;
  }

  const voiceResponse = new Twiml.VoiceResponse();

  try {
    const { state, replyText, isFinished } = await handleUserInput(callId, userText);

    // Si llegamos al paso de creación, mandamos una llamada de ejemplo a la API.
    if (state.step === 'creatingAppointment' && state.type !== null) {
      // NOTA: En una implementación real, aquí habría que
      // - Resolver customerId a partir de state.customerNameSpoken
      // - Calcular startDateISO en base a lo que dijo el usuario
      // Por ahora, solo mostramos cómo se llamaría a la API.
      const now = new Date();
      const isoNow = now.toISOString();

      // Validaciones mínimas antes de intentar crear la cita
      if (!state.customerId) {
        // En esta versión de ejemplo aún no resolvemos el customerId real.
        // Evitamos crear citas inválidas.
        // eslint-disable-next-line no-console
        console.warn(
          'No se pudo crear la cita: falta customerId. Se requiere resolverlo contra la API de clientes.',
        );
      } else {
        const payload: CreateAppointmentPayload = {
          customerId: state.customerId,
          type: state.type,
          startDate: state.startDateISO ?? isoNow,
          duration: state.duration ?? '01:00:00',
          status: state.status,
          userId: state.userId ?? undefined,
          saleOrderId: state.saleOrderId ?? undefined,
          installationContactId: state.installationContactId ?? undefined,
          remarks: state.remarks ?? undefined,
        };

        try {
          await createAppointment(payload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('Error al crear cita en BlindsBook:', err);
        }
      }
    }

    const isAskingLanguage = state.step === 'askLanguage';
    const twilioLang = state.language === 'en' ? 'en-US' : 'es-ES';

    const gather = voiceResponse.gather({
      input: isAskingLanguage ? ['dtmf', 'speech'] : ['speech', 'dtmf'],
      numDigits: isAskingLanguage ? 1 : undefined,
      speechTimeout: 'auto',
      action: '/twilio/voice-webhook',
      method: 'POST',
      language: twilioLang,
    });

    gather.say(
      {
        language: twilioLang,
        voice: state.language === 'en' ? 'Polly.Joanna' : 'Polly.Lucia',
      } as any,
      replyText,
    );

    if (isFinished) {
      clearConversationState(callId);
      voiceResponse.hangup();
    } else {
      setConversationState(callId, state);
    }

    res.type('text/xml');
    res.send(voiceResponse.toString());
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error en webhook de Twilio:', error);
    const errorResponse = new Twiml.VoiceResponse();
    errorResponse.say(
      {
        language: 'es-ES',
      } as any,
      'Ha ocurrido un error procesando tu llamada. Por favor intenta más tarde.',
    );
    errorResponse.hangup();
    res.type('text/xml');
    res.send(errorResponse.toString());
  }
});

