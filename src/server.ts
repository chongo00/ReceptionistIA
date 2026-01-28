import express from 'express';
import bodyParser from 'body-parser';
import { twilioVoiceRouter } from './twilio/voiceWebhook.js';
import { handleUserInput, setConversationState, clearConversationState } from './dialogue/manager.js';
import { loadEnv } from './config/env.js';
import { setTokenForCompany, clearTokenOverride, createAppointment } from './blindsbook/appointmentsClient.js';
import type { CreateAppointmentPayload } from './models/appointments.js';

export async function startServer() {
  const app = express();
  const env = loadEnv();

  // Twilio envía datos como application/x-www-form-urlencoded por defecto
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'receptionist-ai', status: 'healthy' });
  });

  // Modo 100% local/gratis (sin Twilio): simula turnos de conversación.
  // POST /debug/chat { callId: "test", text: "hola", toNumber: "+123..." }
  app.post('/debug/chat', async (req, res) => {
    const callId = String(req.body?.callId || 'local-test');
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const toNumber = typeof req.body?.toNumber === 'string' ? req.body.toNumber : null;

    // Permite probar multi-tenant en local simulando el número Twilio (To)
    if (toNumber) {
      const cfg = env.twilioNumberToCompanyMap.get(toNumber);
      if (cfg) setTokenForCompany(cfg.token);
    } else {
      clearTokenOverride();
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

