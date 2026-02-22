# Guía: Voces Neurales para Receptionist IA

## Opción A — Azure Speech (Recomendado para empezar rápido)

Azure Cognitive Services Speech ofrece voces neurales de alta calidad con soporte nativo SSML. Ya está integrado en el proyecto (`azureNeuralTts.ts`).

### Paso 1: Crear recurso en Azure Portal

1. Ve a [portal.azure.com](https://portal.azure.com)
2. Busca **"Speech"** → Click **"Create a resource"** → **"Speech"**
3. Configuración:
   - **Subscription**: Tu suscripción de Azure
   - **Resource group**: `rg-blindsbook-test` (o crear uno nuevo)
   - **Region**: `eastus` (misma región que tu app para menor latencia)
   - **Name**: `blindsbook-speech` (o cualquier nombre)
   - **Pricing tier**: **Free (F0)** → 500K caracteres/mes gratis, suficiente para pruebas
     - O **Standard (S0)** → $16/millón de caracteres para producción
4. Click **"Review + Create"** → **"Create"**

### Paso 2: Obtener las claves

1. Ve al recurso creado → **"Keys and Endpoint"**
2. Copia **Key 1** y la **Region** (ej: `eastus`)

### Paso 3: Configurar en el proyecto

Edita el archivo `.env` de Receptionist IA:

```env
AZURE_SPEECH_KEY=tu_clave_aqui
AZURE_SPEECH_REGION=eastus

# Voces opcionales (ya tienen defaults buenos)
AZURE_TTS_VOICE_ES=es-MX-DaliaNeural      # Mexicana, cálida y natural
AZURE_TTS_VOICE_EN=en-US-JennyNeural       # US, profesional y amable
```

### Paso 4: Reiniciar Docker

```bash
docker compose down && docker compose up -d
```

### Voces recomendadas

| Idioma | Voz | Estilo | Notas |
|--------|-----|--------|-------|
| es-MX | `es-MX-DaliaNeural` | Cálida, profesional | **Default** - ideal para público US-Hispanic |
| es-MX | `es-MX-JorgeNeural` | Masculina, clara | Alternativa masculina |
| es-ES | `es-ES-ElviraNeural` | Profesional, España | Para público español |
| en-US | `en-US-JennyNeural` | Amable, natural | **Default** |
| en-US | `en-US-AriaNeural` | Expresiva | Más emocional |
| en-US | `en-US-GuyNeural` | Masculina | Alternativa masculina |

### Precio estimado

- **Free tier (F0)**: 500K caracteres/mes → ~50 llamadas de 5 min → **$0/mes**
- **Standard (S0)**: $16/millón de caracteres → ~$0.001 por respuesta → **~$5-15/mes** para uso moderado

---

## Opción B — Retell AI (Plataforma completa de Voice AI)

[Retell AI](https://www.retellai.com) es una plataforma todo-en-uno (#1 en G2) que reemplazaría la arquitectura actual de Twilio + Ollama + TTS. Usa LLMs para conversación natural con latencia de ~600ms.

### ¿Qué ofrece?

| Feature | Receptionist IA actual | Retell AI |
|---------|----------------------|-----------|
| Voice Engine | Twilio `<Say>` / Piper / Azure | Motor propio ultra-realista |
| Latencia | ~3-4s (LLM + TTS) | ~600ms |
| Turn-taking | Básico (`speechTimeout: auto`) | Modelo propietario inteligente |
| LLM | Ollama qwen2.5:3b local | GPT-4o, Claude, Gemini (all built-in) |
| Telephony | Twilio (config manual) | Integrado / SIP trunk |
| Function calling | Custom code | Visual drag-and-drop + API |
| Knowledge base | N/A | RAG integrado con auto-sync |
| Analytics | Logs manuales | Dashboard completo |
| Quality testing | Manual | Simulación automática |

### Precios Retell AI (Pay-as-you-go, sin platform fee)

| Componente | Costo |
|-----------|-------|
| **Retell Voice Infra** | $0.055/min |
| **Cartesia/ElevenLabs voices** | $0.015/min |
| **GPT-4o mini (LLM)** | $0.006/min |
| **Twilio telephony** | $0.015/min |
| | |
| **TOTAL típico** | **~$0.09/min** |
| Phone number | $2/mes |
| Concurrency (20 free) | $8/concurrency/mes |

- **$10 de crédito gratis** al registrarse
- **20 llamadas concurrentes gratis**
- **10 knowledge bases gratis**
- Llamadas internacionales US: $0.015/min, MX: $0.05/min

### Cómo integrar Retell AI

#### Opción B1: Reemplazo total (más simple)

Retell maneja TODO: telephony, LLM, TTS, turn-taking. Solo necesitas:

1. **Crear cuenta**: https://dashboard.retellai.com/
2. **Crear agente** desde template "Receptionist" o "Appointment Setter"
3. **Configurar prompt** con las instrucciones de BlindsBook
4. **Agregar funciones** (custom API calls):
   - `searchCustomer(phone)` → llama a tu API de BlindsBook
   - `createAppointment(data)` → crea cita en BlindsBook
5. **Conectar telephony**:
   - Comprar número en Retell, o
   - Conectar tus números Twilio existentes via **SIP Trunking**
6. **Agregar Knowledge Base** con FAQ de BlindsBook

```
Ventaja: Latencia ~600ms, voces ultra-realistas, 0 infraestructura
Desventaja: Menos control, dependencia de tercero, costo por minuto
```

#### Opción B2: Integración parcial (híbrido)

Mantener tu lógica de negocio actual y usar Retell solo como voice engine:

1. Conectar Retell via **SIP Trunking** a tu Twilio
2. Usar **Retell SDK** para manejar voice + STT
3. Tu backend (Receptionist IA) maneja la lógica de dialogue
4. Las respuestas se envían a Retell para TTS

```typescript
// npm install retell-ai-sdk
import { RetellClient } from 'retell-ai-sdk';

const retell = new RetellClient({ apiKey: 'tu_api_key' });

// Crear agente con custom LLM
const agent = await retell.agent.create({
  agent_name: 'BlindsBook Receptionist',
  llm_websocket_url: 'wss://tu-servidor.com/retell-llm',  // Tu backend
  voice_id: 'eleven_labs_voice_id',
  language: 'es',
});
```

### Comparación de costos mensuales (estimado 500 llamadas/mes × 3 min promedio = 1500 min)

| Solución | Costo/mes |
|----------|-----------|
| **Actual (Twilio + Ollama + Azure TTS)** | ~$15 Twilio + $3 Azure TTS + $0 Ollama = **~$18/mes** |
| **Retell AI completo** | 1500 × $0.09 + $2 number = **~$137/mes** |
| **Actual + Azure Speech mejorado** | ~$15 Twilio + $5 Azure Speech = **~$20/mes** |

### Recomendación

| Escenario | Recomendación |
|-----------|---------------|
| **Prototipo / bajo volumen (<200 llamadas/mes)** | **Azure Speech** — Ya integrado, casi gratis |
| **Calidad premium sin esfuerzo** | **Retell AI completo** — Mejor experiencia de usuario |
| **Control total + escala** | **Actual + Azure Speech** — Más barato a escala |
| **Demo para inversionistas** | **Retell AI** — Impresiona con latencia de 600ms |

---

## Quick Start: Azure Speech en 5 minutos

```bash
# 1. Configurar variables en .env
echo "AZURE_SPEECH_KEY=tu_clave" >> .env
echo "AZURE_SPEECH_REGION=eastus" >> .env

# 2. Reiniciar
docker compose down && docker compose up -d

# 3. Probar
curl -X POST http://localhost:4000/twilio/voice-webhook \
  -d "CallSid=test123&From=+17862944232&To=+15550000002&SpeechResult=español"
```

Las voces neurales con SSML humanizado se activarán automáticamente. 🎙️
