import express from 'express';
import twilio from 'twilio';
import { handleUserInput, getConversationState, setConversationState, clearConversationState } from '../dialogue/manager.js';
import { loadEnv } from '../config/env.js';
import { createAppointment } from '../blindsbook/appointmentsClient.js';
import { setTokenForCompany, clearTokenOverride } from '../blindsbook/appointmentsClient.js';
import type { CreateAppointmentPayload } from '../models/appointments.js';
import { putAudio } from '../tts/ttsCache.js';
import { synthesizeTts } from '../tts/ttsProvider.js';

export const twilioVoiceRouter = express.Router();

const env = loadEnv();

twilioVoiceRouter.post('/voice-webhook', async (req, res) => {
  const callId = String(req.body.CallSid || '');
  const toNumber = typeof req.body.To === 'string' ? req.body.To : null;
  const fromNumber = typeof req.body.From === 'string' ? req.body.From : null;
  const digits = typeof req.body.Digits === 'string' ? req.body.Digits : null;
  const speechResult =
    typeof req.body.SpeechResult === 'string' ? req.body.SpeechResult : null;

  const companyConfig = toNumber ? env.twilioNumberToCompanyMap.get(toNumber) : null;
  if (companyConfig) {
    setTokenForCompany(companyConfig);
    console.log(`[Twilio] Using token for company ${companyConfig.companyId} (number: ${toNumber})`);
  } else if (env.blindsbookApiToken) {
    clearTokenOverride();
  }

  if (fromNumber) {
    const existingState = getConversationState(callId);
    if (!existingState.callerPhone) {
      existingState.callerPhone = fromNumber;
      setConversationState(callId, existingState);
    }
  }

  const userText = speechResult || digits || null;

  const voiceResponse = new twilio.twiml.VoiceResponse();

  try {
    const { state, replyText, isFinished } = await handleUserInput(callId, userText);

    if (state.step === 'creatingAppointment' && state.type !== null) {
      const now = new Date();
      const isoNow = now.toISOString();

      if (!state.customerId) {
        console.warn(
          'Cannot create appointment: missing customerId. Must be resolved via the customers API.',
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
          console.error('Error creating appointment in BlindsBook:', err);
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

    const canUseTts = Boolean(env.publicBaseUrl && env.publicBaseUrl.startsWith('http'));

    if (canUseTts) {
      try {
        const ttsResult = await synthesizeTts(
          replyText,
          state.language === 'en' ? 'en' : 'es',
        );
        if (ttsResult) {
          const id = putAudio(ttsResult.bytes, ttsResult.contentType, 10 * 60);
          const base = String(env.publicBaseUrl).replace(/\/$/, '');
          const audioUrl = `${base}/tts/${id}.mp3`;
          gather.play({}, audioUrl);
          console.log(`[TTS] Using provider: ${ttsResult.provider}`);
        } else {
          gather.say(
            {
              language: twilioLang,
              voice: state.language === 'en' ? 'Polly.Joanna-Neural' : 'Polly.Lupe-Neural',
            } as any,
            replyText,
          );
        }
      } catch (e) {
        console.warn('[TTS] Failed; using Twilio <Say> fallback:', e);
        gather.say(
          {
            language: twilioLang,
            voice: state.language === 'en' ? 'Polly.Joanna-Neural' : 'Polly.Lupe-Neural',
          } as any,
          replyText,
        );
      }
    } else {
      gather.say(
        {
          language: twilioLang,
          voice: state.language === 'en' ? 'Polly.Joanna-Neural' : 'Polly.Lupe-Neural',
        } as any,
        replyText,
      );
    }

    if (isFinished) {
      clearConversationState(callId);
      voiceResponse.hangup();
    } else {
      setConversationState(callId, state);
    }

    res.type('text/xml');
    res.send(voiceResponse.toString());
  } catch (error) {
    console.error('Error in Twilio webhook:', error);
    const errorResponse = new twilio.twiml.VoiceResponse();
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
