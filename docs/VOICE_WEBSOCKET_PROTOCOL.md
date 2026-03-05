# Protocolo WebSocket del agente de voz

Ruta: `/ws/voice`. Los frames binarios = audio en bruto (PCM 16 kHz 16 bits mono). Los frames de texto = JSON.

## Cliente → Servidor (mensajes JSON)

| type     | payload | descripción |
|----------|---------|-------------|
| `init`   | `{ callerId?: string; companyPhone?: string; language?: 'es' \| 'en' }` | Iniciar sesión; caller/empresa opcionales para búsqueda. |
| `language` | `{ language: 'es' \| 'en' }` | Establecer idioma y disparar el primer paso del diálogo. |
| `text`   | `{ text: string }` | Entrada por teclado/debug; se procesa como voz. |
| `hangup` | — | Finalizar llamada; el servidor envía `finished` y cierra. |
| `ping`   | — | Mantener conexión; el servidor responde con `pong`. |

**Audio:** Enviar PCM 16 kHz 16 bits mono en bruto como frames WebSocket binarios. Solo se procesa cuando el servidor ha iniciado la escucha (tras `language` o tras una respuesta).

## Servidor → Cliente (mensajes JSON)

| type      | campos | descripción |
|-----------|--------|-------------|
| `state`   | `data?: { sessionId?, status?, listening?, speaking?, textOnly? }; text?: string; state?: ConversationState` | Estado de sesión/UI. Tras `language`, el servidor puede enviar `state` con `text` y `state` para la primera respuesta. |
| `greeting`| `text: string; state?: ConversationState` | Primera respuesta tras `init` (pregunta de idioma o saludo con nombre). |
| `interim`| `text: string` | Transcripción parcial (en vivo). |
| `final`   | `text: string; state?: ConversationState` | Texto de respuesta final y estado de conversación opcional. |
| `audio`   | `audioBase64: string; text?: string; data?: { sentenceIndex, totalSentences, isLastChunk }` | Un fragmento TTS (PCM en base64). |
| `finished`| `text: string` | Conversación terminada; el cliente puede cerrar. |
| `error`   | `text: string` | Error de STT/TTS/LLM o del servidor. |
| `pong`    | — | Respuesta a `ping`. |

Todos los eventos se envían como un único objeto JSON con un `type` y los campos anteriores. El frontend (`voice-test-v2.html`) puede basarse en `state`, `interim`, `final`, `audio`, `greeting`, `finished`, `error` para la UI y la reproducción.
