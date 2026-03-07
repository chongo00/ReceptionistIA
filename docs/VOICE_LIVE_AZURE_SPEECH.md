# Voice Live API con recurso Azure Speech

La [Voice Live API](https://ai.azure.com/catalog/models/Azure-Speech-Voice-Live) está disponible con un recurso **Azure Speech** (o Azure AI Services). El punto importante es el **formato del endpoint**: Voice Live **no** usa la URL regional; usa el endpoint **por recurso**.

---

## Endpoint correcto (documentación oficial)

Según [How to use the Voice Live API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to):

- **Recursos antiguos (Azure Speech en Foundry Tools):**  
  `wss://<resource-name>.cognitiveservices.azure.com/voice-live/realtime?api-version=2025-10-01`

- **Recursos nuevos (Microsoft Foundry):**  
  `wss://<resource-name>.services.ai.azure.com/voice-live/realtime?api-version=2025-10-01`

La URL regional tipo **`eastus.api.cognitive.microsoft.com`** **no** es válida para Voice Live; el servicio solo está expuesto en el endpoint por recurso (host con el nombre del recurso).

---

## Cómo obtener tu endpoint con un recurso Azure Speech

1. Ve al **Portal Azure** → tu recurso **Speech** (el que tiene la clave que usas para STT/TTS).
2. Abre **Keys and Endpoint** (Claves y punto de conexión).
3. Mira el campo **Endpoint**:
   - Si ves algo como **`https://mi-recurso.cognitiveservices.azure.com`**  
     → En `.env` pon:  
     **`VOICE_LIVE_ENDPOINT=wss://mi-recurso.cognitiveservices.azure.com`**  
     (puedes pegar la URL con `https://`; el código la convierte a `wss://`).
   - Si solo ves una URL **regional** (por ejemplo `https://eastus.api.cognitive.microsoft.com`):
     - El **nombre del recurso** es el que aparece en la parte superior de la hoja del recurso (o en la lista de recursos).
     - Prueba: **`VOICE_LIVE_ENDPOINT=wss://<ese-nombre>.cognitiveservices.azure.com`**  
       Sustituye `<ese-nombre>` por el nombre real del recurso (sin espacios; suele ser el que diste al crearlo).
4. **Key 1** de esa misma hoja → **`VOICE_LIVE_API_KEY`** en el `.env`.

---

## Variables en `.env`

```env
# Obligatorio: endpoint por recurso (no regional)
VOICE_LIVE_ENDPOINT=wss://TU-NOMBRE-RECURSO.cognitiveservices.azure.com

# Key 1 del recurso Speech (Keys and Endpoint)
VOICE_LIVE_API_KEY=tu-key

# Modelo; gpt-4o-mini es válido para Voice Live
VOICE_LIVE_MODEL=gpt-4o-mini

# Voice Live API exige esta versión
VOICE_LIVE_API_VERSION=2025-10-01
```

---

## Si sigue sin conectar

- Revisa los **logs del servidor** al hacer “Llamar” en el simulador. Verás líneas `[VoiceLive] Connecting to ...` y, si falla, `[VoiceLive] WebSocket closed: code=... reason=...` o un timeout.
- **401/403:** clave incorrecta o recurso distinto al que tiene Voice Live habilitado.
- **Timeout / conexión rechazada:** host o puerto incorrectos; confirma que usas el host **por recurso** (`*.cognitiveservices.azure.com` o `*.services.ai.azure.com`), no `eastus.api.cognitive.microsoft.com`.
- En [Supported models and regions](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live#supported-models-and-regions) puedes comprobar que tu región y modelo están soportados.

---

## Referencias

- [Voice Live API - How to](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [Azure Speech Voice Live - Model Catalog](https://ai.azure.com/catalog/models/Azure-Speech-Voice-Live)
