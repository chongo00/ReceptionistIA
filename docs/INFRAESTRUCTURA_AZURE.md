# Guia de Infraestructura — Azure Speech + Azure OpenAI + Twilio

> **Fecha:** Febrero 2026  
> **Proyecto:** BlindsBook Receptionist IA  
> **Arquitectura:** Azure OpenAI (LLM) + Azure Speech (TTS) + Twilio (telefonia) + API BlindsBook (backend)

---

## Resumen de Arquitectura

```
Llamada telefonica
      │
      ▼
   TWILIO ──── STT (Speech-to-Text via Twilio <Gather>)
      │
      ▼
┌─────────────────────────┐
│   Receptionist IA       │  ◄── Docker (Node.js, ~200MB)
│   (puerto 4000)         │
│                         │
│  ┌───────────────────┐  │
│  │ Dialogue Manager  │  │  ◄── Estado de conversacion (in-memory)
│  │ (state machine)   │  │
│  └────────┬──────────┘  │
│           │              │
│  ┌────────▼──────────┐  │
│  │  Azure OpenAI     │  │  ◄── Solo para Level 3 (identificacion LLM)
│  │  (GPT-4o-mini)    │  │      $0.15/1M tokens input
│  └───────────────────┘  │
│           │              │
│  ┌────────▼──────────┐  │
│  │  Azure Speech     │  │  ◄── TTS para voz neural humanizada
│  │  (Neural TTS)     │  │      $16/1M caracteres
│  └───────────────────┘  │
│           │              │
│  ┌────────▼──────────┐  │
│  │  API BlindsBook   │  │  ◄── Clientes, citas, equipo
│  │  (Azure Cloud)    │  │      Ya existente
│  └───────────────────┘  │
└─────────────────────────┘
      │
      ▼
   TWILIO ──── TTS audio via <Play> (o <Say> Polly fallback)
      │
      ▼
  Cliente escucha respuesta
```

---

## 1. Que necesitas crear en Azure (2 recursos)

### 1A. Azure OpenAI Service (LLM — GPT-4o-mini)

| Campo | Valor |
|-------|-------|
| **Que es** | El cerebro de IA que identifica clientes cuando el telefono y nombre fallan (Level 3) |
| **Costo estimado** | ~$0.15 por 1M tokens input / ~$0.60 por 1M tokens output. Para 100 llamadas/dia ≈ **$1-5/mes** |
| **Donde crearlo** | [portal.azure.com](https://portal.azure.com) → Buscar **"Azure OpenAI"** → **Create** |

**Pasos exactos:**

1. Ve a [portal.azure.com](https://portal.azure.com)
2. Busca **"Azure OpenAI"** en la barra de busqueda
3. Click **"Create"**
4. **Subscription:** Selecciona tu suscripcion de Azure
5. **Resource Group:** Usa uno existente o crea `rg-blindsbook-ai`
6. **Region:** `East US` (recomendado — misma region que tu API)
7. **Name:** `blindsbook-openai` (o el que quieras)
8. **Pricing Tier:** `Standard S0`
9. Click **Review + Create** → **Create**
10. Espera a que se cree (~2 minutos)

**Despues de crear el recurso:**

11. Ve al recurso → **Keys and Endpoint** (menu izquierdo)
12. Copia:
    - **Endpoint:** `https://blindsbook-openai.openai.azure.com/` → ponlo en `AZURE_OPENAI_ENDPOINT`
    - **Key 1:** → ponlo en `AZURE_OPENAI_API_KEY`
13. Ve a **Model deployments** → **Manage Deployments** (abre Azure AI Studio)
14. Click **+ Create new deployment**
15. **Model:** `gpt-4o-mini` (mas barato y rapido) o `gpt-4o` (mas potente)
16. **Deployment name:** `gpt-4o-mini` → ponlo en `AZURE_OPENAI_DEPLOYMENT`
17. **Tokens per Minute Rate Limit:** 30K (suficiente para pruebas)
18. Click **Create**

> **NOTA:** Si Azure OpenAI no esta disponible en tu suscripcion, puede que necesites solicitar acceso en [https://aka.ms/oai/access](https://aka.ms/oai/access). Aprobacion suele tardar 1-2 dias laborales.

---

### 1B. Azure Speech Service (TTS — Voz Neural)

| Campo | Valor |
|-------|-------|
| **Que es** | Convierte texto a voz con voces neuronales humanizadas (ES: DaliaNeural, EN: JennyNeural) |
| **Costo estimado** | $16 por 1M caracteres. Para 100 llamadas/dia ≈ **$2-8/mes** |
| **Donde crearlo** | [portal.azure.com](https://portal.azure.com) → Buscar **"Speech"** → **Create** |

**Pasos exactos:**

1. Ve a [portal.azure.com](https://portal.azure.com)
2. Busca **"Speech"** o **"Speech Services"** en la barra
3. Click **"Create"**
4. **Subscription:** La misma
5. **Resource Group:** `rg-blindsbook-ai`
6. **Region:** `East US`
7. **Name:** `blindsbook-speech`
8. **Pricing Tier:** `Free F0` (500K caracteres gratis/mes — perfecto para pruebas) o `Standard S0`
9. Click **Review + Create** → **Create**

**Despues de crear:**

10. Ve al recurso → **Keys and Endpoint**
11. Copia:
    - **Key 1** → ponlo en `AZURE_SPEECH_KEY`
    - **Location/Region** → ponlo en `AZURE_SPEECH_REGION` (ej: `eastus`)

---

## 2. Twilio (ya lo tienes parcialmente)

| Campo | Valor |
|-------|-------|
| **Que es** | Servicio de telefonia que recibe llamadas y envia audio TTS al cliente |
| **Costo** | ~$1/mes por numero + ~$0.013/min por llamada |
| **Donde** | [console.twilio.com](https://console.twilio.com) |

**Lo que necesitas de Twilio (cuando pases a pruebas reales):**

1. Cuenta Twilio (trial gratis para empezar)
2. Un numero de telefono Twilio (Buy a Number)
3. `TWILIO_AUTH_TOKEN` — en Dashboard → Account Info
4. Configurar el webhook: Phone Number → Voice → Webhook URL → `https://TU-URL/twilio/voice-webhook`
5. `PUBLIC_BASE_URL` — URL publica donde Twilio puede alcanzar tu servidor (ngrok para local)

> **Para pruebas locales con voice-test.html NO necesitas Twilio.** Solo se usa para llamadas telefonicas reales.

---

## 3. Donde poner las credenciales

Todas van en el archivo `.env` de la raiz del proyecto. Aqui estan las lineas exactas que debes editar:

```bash
# ======================== EDITAR ESTAS LINEAS ========================

# Azure OpenAI (LLM) — de la seccion 1A arriba
AZURE_OPENAI_ENDPOINT=https://TU-RECURSO.openai.azure.com
AZURE_OPENAI_API_KEY=abc123...tu-key-aqui
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini

# Azure Speech (TTS) — de la seccion 1B arriba
AZURE_SPEECH_KEY=xyz789...tu-key-aqui
AZURE_SPEECH_REGION=eastus

# ====================== NO TOCAR LO DEMAS ===========================
```

**Ruta del archivo:** `Receptionist IA/.env`

---

## 4. Verificacion rapida

Despues de poner las credenciales, ejecuta estos comandos:

```powershell
# Reconstruir Docker (1-2 minutos — ya no son 30+ min con Ollama)
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
docker compose down
docker compose up -d --build

# Esperar 10s a que inicie
Start-Sleep 10

# Health check — debe mostrar: llm="azure-openai", tts="azure-speech"
Invoke-RestMethod -Uri "http://localhost:4000/health"

# Probar TTS — debe generar audio MP3
Invoke-WebRequest -Uri "http://localhost:4000/debug/play-audio?text=Hola%20bienvenido&lang=es" -UseBasicParsing -OutFile "test_audio.mp3"
Start-Process "test_audio.mp3"

# Probar LLM (chat simple)
$body = @{message="hola"; toNumber="+15550000001"; callerPhone="305-545-2936"} | ConvertTo-Json
Invoke-RestMethod -Method POST -Uri "http://localhost:4000/debug/chat" -ContentType "application/json" -Body $body

# Abrir pagina de pruebas de voz
Start-Process "http://localhost:4000/test/voice-test.html"
```

---

## 5. Costos mensuales estimados

| Servicio | Tier | Estimado (100 llamadas/dia) |
|----------|------|-----------------------------|
| Azure OpenAI (GPT-4o-mini) | Standard S0 | $1 - $5 /mes |
| Azure Speech (Neural TTS) | Free F0 → S0 | $0 - $8 /mes |
| Twilio (1 numero + llamadas) | Pay-as-you-go | $1 + $0.013/min |
| Docker container (CPU only) | — | Sin costo adicional |
| **Total estimado** | | **$2 - $20 /mes** |

> **Azure Speech Free Tier (F0):** 500,000 caracteres/mes gratis. Perfecto para desarrollo y pruebas.

---

## 6. Diferencias vs Arquitectura Anterior

| Aspecto | Antes (Ollama) | Ahora (Azure OpenAI) |
|---------|---------------|----------------------|
| **Imagen Docker** | ~4 GB (Ubuntu + Ollama + modelo 2GB) | ~200 MB (Node.js slim) |
| **Build time** | 30-60 min (descarga modelo) | 1-2 min |
| **RAM necesaria** | 6 GB minimo | 512 MB |
| **GPU** | Recomendada (sin GPU = lento) | No necesaria |
| **LLM calidad** | qwen2.5:3b (3B params, basico) | GPT-4o-mini (muy superior) |
| **TTS** | Piper local (robotico) o nada | Azure Neural (humano) |
| **Costo** | $0 (pero hardware caro) | ~$5-20/mes |
| **Latencia LLM** | 5-15s (CPU) | 1-3s |
| **Tool calling** | Inestable con modelos pequenos | Nativo y confiable |

---

## 7. Arquitectura de Archivos Modificados

```
src/
├── llm/
│   ├── azureOpenaiClient.ts   ← NUEVO — cliente Azure OpenAI
│   ├── llmClient.ts           ← NUEVO — dispatcher (Azure → Ollama fallback)
│   ├── ollamaClient.ts        ← SIN CAMBIOS — ahora es fallback
│   └── identificationAgent.ts ← MODIFICADO — usa llmClient.ts en vez de ollamaClient.ts
├── tts/
│   ├── ttsProvider.ts         ← SIN CAMBIOS — ya soportaba Azure Speech
│   ├── azureNeuralTts.ts      ← SIN CAMBIOS — solo faltaban las keys
│   └── dockerTts.ts           ← SIN CAMBIOS — desactivado (DOCKER_TTS_URL vacio)
├── config/
│   └── env.ts                 ← MODIFICADO — 4 nuevas variables Azure OpenAI
├── server.ts                  ← MODIFICADO — health check muestra llm provider + tts
└── twilio/
    └── voiceWebhook.ts        ← SIN CAMBIOS

Dockerfile.cloud               ← NUEVO — imagen ligera sin Ollama (~200MB)
docker-compose.yml             ← MODIFICADO — usa Dockerfile.cloud, nuevas env vars
.env                           ← MODIFICADO — nuevas secciones Azure OpenAI
.env.example                   ← MODIFICADO — documentacion actualizada
```

---

*Ultima actualizacion: Febrero 2026*
