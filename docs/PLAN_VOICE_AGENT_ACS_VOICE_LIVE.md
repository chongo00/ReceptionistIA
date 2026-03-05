# Plan: Agente de voz fluido con ACS + Voice Live

Este documento es la referencia del agente de voz del Receptionist IA, con integración futura a Azure Communication Services (ACS) y Azure AI Voice Live API.

---

## Objetivo

Garantizar conversaciones fluidas, baja latencia, escalabilidad y correcta asignacion de citas al account manager, con camino claro hacia produccion via ACS + Voice Live.

---

## Criterios de exito

- **Fluidez:** Respuestas cortas, backchannels durante busquedas, estilo conversacional documentado.
- **Baja latencia:** STT con silencios cortos (1 s), TTS por frases (streaming), barge-in para no bloquear al usuario.
- **Escalabilidad:** Limite de sesiones concurrentes (20), rate limiting TTS (15), timeouts y limpieza de sesiones inactivas.
- **Correctitud:** `userId` = account manager del cliente identificado al crear citas en BlindsBook.
- **Robustez:** Manejo de errores en todo el pipeline (STT, LLM, TTS), recuperacion automatica de sesiones bloqueadas.

---

## Fases implementadas

### 1. Guia de estilo conversacional

- **Documento:** `docs/CONVERSATIONAL_STYLE.md` (espanol).
- **Codigo:** `src/dialogue/conversationalLlm.ts` con instrucciones de estilo; `src/dialogue/humanizer.ts` con frases ES/EN (GREETINGS_ES/EN, HOW_CAN_HELP_ES/EN, PERFECT_ES/EN, WAIT_ES/EN, SORRY_ES/EN, GOODBYE_ES/EN).

### 2. Protocolo WebSocket

- **Documento:** `docs/VOICE_WEBSOCKET_PROTOCOL.md` (espanol).
- Mensajes C->S: `init`, `language`, `text`, `hangup`, `ping`. Audio en bruto (PCM 16 kHz 16 bits).
- Mensajes S->C: `state`, `greeting`, `interim`, `final`, `audio`, `finished`, `error`, `pong`.

### 3. Barge-in y control de turnos

- **Codigo:** `src/realtime/voiceWebSocket.ts`.
- `VoiceSession`: `currentTtsId`, `pendingBargeIn`; `cancelCurrentSpeech()`; en `handleAudioData` se cancela TTS en curso y se reanuda escucha; en `speakResponse` se comprueba `ttsId` antes de enviar cada fragmento.

### 4. STT (baja latencia)

- **Codigo:** `src/stt/azureSpeechStt.ts`, `src/realtime/voiceWebSocket.ts`.
- `Speech_SegmentationSilenceTimeoutMs` por defecto **1000 ms**. El reconocedor se crea con `silenceTimeoutMs: 1000` en `startListening`.

### 5. TTS streaming por frases

- **Codigo:** `src/tts/azureSpeechSdkTts.ts`, `speakResponse` en `voiceWebSocket.ts`.
- `speakResponse` usa `synthesizeSpeechStreaming` por frase; SSML con `rate="0%"`, pausas en `humanizer.ts` (250 ms / 150 ms).
- Voz por defecto: `es-MX-DaliaNeural` (ES), `en-US-JennyNeural` (EN) — voces femeninas que coinciden con la persona "Sara/Sarah".

### 6. Telemetria

- **Codigo:** `src/realtime/voiceWebSocket.ts`.
- Campos en sesion: `initAt`, `languageSelectedAt`, `speechFinalAt`.
- Logs: `t_connect_to_greeting`, `t_language_to_identified_greeting`, `t_user_final_to_first_audio_chunk`, `tts_ms`, `tts_bytes`, y estadisticas periodicas de sesiones/TTS.

### 7. Simulador solo local / produccion

- **Codigo:** `src/config/env.ts`: `voiceSimulatorEnabled` (por defecto `true`). `src/server.ts`: ruta `/test` solo se monta si esta habilitado.
- **Documento:** `docs/ACS_VOICE_LIVE_INTEGRATION.md` (espanol).
- **Produccion:** En el `.env` del servidor debe definirse `VOICE_SIMULATOR_ENABLED=false` para no exponer el simulador.

### 8. userId = accountManagerId

- **Codigo:** `src/dialogue/manager.ts`.
- Al fijar cliente: `userId: match.accountManagerId ?? state.userId` en identifyByCallerId, disambiguateCustomer (eleccion y nameMatch) y confirmCustomerIdentity (isYes).

### 9. Manejo robusto de errores

- **Codigo:** `src/realtime/voiceWebSocket.ts`.
- `processSpeechResult` con try/catch completo: si `handleUserInput` o TTS fallan, la sesion se recupera automaticamente (resetea `isSpeaking`, notifica error al cliente, reanuda STT listening).
- `handleTextInput` con recuperacion similar — siempre reanuda listening tras error.
- `handleInit` arranca STT listening tras el saludo si la sesion ya paso seleccion de idioma.

---

## Variables de entorno relevantes

| Variable | Descripcion | Produccion |
|----------|-------------|------------|
| `VOICE_SIMULATOR_ENABLED` | Si es `false`, no se sirve `/test` (simulador). Por defecto `true`. | Debe ser `false` |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | STT y TTS | Requeridos |
| `AZURE_TTS_VOICE_ES` / `AZURE_TTS_VOICE_EN` | Voces TTS (defecto: DaliaNeural / JennyNeural) | Opcional |
| `AZURE_OPENAI_*` | LLM conversacional | Requeridos |
| `BLINDSBOOK_*` | API y autenticacion | Requeridos |
| `PHONE_TO_COMPANY_MAP` | Mapeo numero -> companyId/token | Requerido (multi-tenant) |

---

## Guia de pruebas manuales

### Prerequisitos

1. Tener `.env` configurado con Azure Speech, Azure OpenAI y BlindsBook API.
2. Levantar el servicio: `npm run dev` o `docker compose up --build`.

### Prueba 1: Health check

```bash
curl http://localhost:4000/health
```

Verificar que responde con `ok: true` y los campos `llm`, `tts`, `stt`, `voiceWebSocket` muestran valores configurados (no "none"/"fallback").

### Prueba 2: Flujo de texto completo (debug/chat)

```bash
# Paso 1: Iniciar conversacion (pregunta idioma)
curl -X POST http://localhost:4000/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test1","text":null}'

# Paso 2: Elegir espanol
curl -X POST http://localhost:4000/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test1","text":"1"}'

# Paso 3: Dar nombre
curl -X POST http://localhost:4000/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test1","text":"Juan Perez"}'

# Paso 4: Confirmar identidad (si aplica)
# Paso 5: Pedir cita
# ... continuar segun los prompts
```

Verificar:
- Cada respuesta tiene `state.step` correcto
- `userId` se asigna al identificar al cliente
- La cita se crea con `userId` = `accountManagerId`

### Prueba 3: Flujo de voz via WebSocket

1. Abrir `http://localhost:4000/test/voice-test-v2.html` (si `VOICE_SIMULATOR_ENABLED=true`)
2. Conectar al WebSocket
3. Enviar `init` con `callerId` opcional
4. Seleccionar idioma
5. Hablar para verificar:
   - STT transcribe correctamente (ver `interim` / `final`)
   - TTS responde con audio (`audio` events con `audioBase64`)
   - Barge-in funciona (hablar mientras TTS reproduce, debe cancelar)
   - La conversacion avanza por los pasos correctos

### Prueba 4: TTS directo

```bash
# Escuchar audio TTS
curl "http://localhost:4000/debug/play-audio?text=Hola%20soy%20Sara&lang=es" --output test.mp3
```

Verificar que el archivo MP3 se reproduce correctamente.

### Prueba 5: Busqueda de clientes

```bash
curl "http://localhost:4000/debug/customer-lookup?phone=5551234567"
```

Verificar que retorna resultados con `accountManagerId`.

### Prueba 6: Sesiones concurrentes

Abrir >1 conexion WebSocket simultanea y verificar:
- Ambas sesiones funcionan independientemente
- Los logs muestran conteo correcto de sesiones
- Al cerrar una, la otra sigue activa

### Prueba 7: Timeout de sesion

1. Conectar WebSocket
2. Esperar 5+ minutos sin actividad
3. Verificar que el servidor envia `finished` y cierra la conexion

### Que verificar en los logs

- `[Voice WS] New connection:` — nuevo WS conectado
- `t_connect_to_greeting=XXms` — latencia de conexion a saludo
- `t_language_to_identified_greeting=XXms` — latencia de idioma a saludo identificado
- `t_user_final_to_first_audio_chunk=XXms` — latencia de voz a respuesta (<500ms ideal)
- `tts_ms=XX tts_bytes=XX` — duracion y tamano de TTS por frase
- `[Voice WS] Stats:` — estadisticas periodicas (cada 5 min)
- No errores `[Voice WS] processSpeechResult error` ni `TTS error`

---

## Camino a produccion: ACS + Voice Live (futuro)

La integracion con ACS + Voice Live API (Opcion A del doc de integracion) permitira:

- **STT/TTS gestionado por Voice Live** en vez de nuestro pipeline
- **VAD semantico** (`azure_semantic_vad_multilingual`) para mejor deteccion de turnos
- **Echo cancellation y noise suppression** del lado del servidor
- **Voces HD** (ej. `en-US-Ava:DragonHDLatestNeural`) con temperatura configurable
- **Function calling** desde Voice Live para crear citas directamente

WebSocket endpoint: `wss://<resource>.services.ai.azure.com/voice-live/realtime?api-version=2025-10-01&model=<model>`

Para detalles, ver `docs/ACS_VOICE_LIVE_INTEGRATION.md`.

---

## Referencias

- [Integración ACS + Voice Live](ACS_VOICE_LIVE_INTEGRATION.md)
- [Protocolo WebSocket de voz](VOICE_WEBSOCKET_PROTOCOL.md)
- [Estilo conversacional](CONVERSATIONAL_STYLE.md)
- [Voice Live API Overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live)
- [Voice Live API How-to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [ACS + Voice Live Blog](https://techcommunity.microsoft.com/blog/azurecommunicationservicesblog/create-next-gen-voice-agents-with-azure-ais-voice-live-api-and-azure-communicati/4414735)
