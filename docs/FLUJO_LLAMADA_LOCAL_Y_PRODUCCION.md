# Flujo del sistema: desde la llamada del cliente (local y producción)

Este documento describe **cómo funciona el sistema de punta a punta**: desde que un cliente inicia la interacción hasta que se cuelga, tanto en **pruebas locales** como en **producción**.

---

## Resumen rápido

| Entorno        | Quién llama        | Cómo entra al backend      | Backend de voz                    |
|----------------|--------------------|----------------------------|-----------------------------------|
| **Local**      | Tú (simulador web) | WebSocket `/ws/voice`      | `VOICE_BACKEND=local` o `voice_live` |
| **Producción** | Cliente (teléfono) | ACS → WebSocket (puente)   | Mismo backend según `VOICE_BACKEND` |

El **mismo servicio** (Receptionist IA en Docker o Node) atiende ambos; solo cambia **quién se conecta** al WebSocket y, en producción, que hay un **puente ACS** delante.

---

## 1. Flujo en pruebas locales

### Quién participa

- **Cliente:** tú, desde el navegador.
- **Frontend:** `http://localhost:4100/test/voice-test-v2.html` (simulador).
- **Backend:** Receptionist IA (Docker en `localhost:4100` o Node en puerto 4000).

### Paso a paso (desde que “llamas”)

1. **Abrir el simulador**  
   - Entras a `http://localhost:4100/test/voice-test-v2.html`.  
   - Opcional: eliges compañía (toNumber), Caller ID y backend: **Local (Azure Speech)** o **Voice Live API**.

2. **Conectar (equivalente a “contestar”)**  
   - Click en **Llamar**.  
   - El navegador abre un **WebSocket** a `ws://localhost:4100/ws/voice` (o a `/ws/voice-live-test` si elegiste solo Voice Live en el dropdown).

3. **Init**  
   - El cliente envía un mensaje JSON `{ "type": "init", "data": { "callerId": "...", "companyPhone": "..." } }`.  
   - El servidor:
     - Crea una sesión (callId).
     - Llama a `handleUserInput(callId, null)` → primera respuesta = menú de idioma.
     - Según `VOICE_BACKEND`:
       - **local:** usa Azure Speech SDK para TTS y envía el audio por el WebSocket; luego arranca STT (mic del navegador).
       - **voice_live:** abre un **VoiceLiveClient** hacia la Voice Live API, envía la respuesta de texto para que Voice Live la convierta en audio y la devuelva; el audio se reenvía al navegador.

4. **Escuchar “Para español presione 1, for English press 2”**  
   - Tú oyes el audio (TTS local o generado por Voice Live).  
   - El servidor ya está escuchando: **local** = Azure STT del mic; **voice_live** = Voice Live recibe el audio del navegador y hace STT.

5. **Responder idioma**  
   - Dices “español” / “uno” o eliges el botón **Español**.  
   - Si es voz: el audio va por el WebSocket → **local:** Azure STT devuelve texto → `handleUserInput(callId, "1")`; **voice_live:** Voice Live STT → texto → mismo `handleUserInput(callId, "1")`.  
   - Si es botón: el cliente envía `{ "type": "language", "data": { "language": "es" } }` → mismo `handleUserInput(callId, "1")`.

6. **Diálogo (identificación, tipo de cita, fecha, etc.)**  
   - El **Dialogue Manager** (`handleUserInput`) hace: búsqueda por Caller ID en BlindsBook, saludo con nombre, preguntas de tipo/fecha/hora, confirmación, creación de cita vía API BlindsBook.  
   - Cada respuesta de texto se convierte en audio (Azure TTS en local, o Voice Live en `voice_live`) y se envía al navegador; el navegador reproduce y vuelve a escuchar.

7. **Colgar**  
   - Click en **Colgar** o el servidor envía `finished`.  
   - El cliente envía `{ "type": "hangup" }`; el servidor cierra la sesión y el WebSocket.

### Diagrama simplificado (local)

```
[Navegador]  ---- WebSocket /ws/voice ----  [Receptionist IA]
     |                                              |
     | init (callerId, companyPhone)                |
     | ------------------------------------------>  | handleUserInput(null) → "Para español..."
     |                                              | TTS (Azure o Voice Live) → audio
     | <------------------------------------------  | greeting + audio
     |                                              |
     | audio (mic) o language {"language":"es"}     |
     | ------------------------------------------>  | handleUserInput("1") → identificación
     |                                              | → BlindsBook API (findCustomersByPhone)
     | <------------------------------------------  | saludo + audio ("¡Hola, María!...")
     |                                              |
     | audio / text (turnos de conversación)        |
     | <----------------------------------------->  | handleUserInput(text) → LLM, citas, etc.
     |                                              |
     | hangup                                       |
     | ------------------------------------------>  | finished, close
```

---

## 2. Flujo en producción (llamada telefónica real)

### Quién participa

- **Cliente:** persona que llama por teléfono.
- **Red telefónica / ACS:** Azure Communication Services recibe la llamada y establece el streaming de audio.
- **Puente (futuro):** servicio que recibe el audio de ACS y se conecta a nuestro backend por WebSocket (o directamente a Voice Live).
- **Backend:** el mismo Receptionist IA (en Azure, Docker, etc.), con `/ws/voice` (y opcionalmente un endpoint específico para ACS).

### Dos variantes en producción

Según cómo esté desplegado:

- **Opción A – Puente a nuestro WebSocket**  
  - ACS envía audio (p. ej. PCM 24 kHz) al **puente**.  
  - El puente se conecta a **nuestro** `wss://.../ws/voice` y reenvía audio entrante/saliente (remuestreando si hace falta).  
  - Nuestro backend se comporta **igual** que en local: mismo `/ws/voice`, mismo `handleUserInput`, mismo `VOICE_BACKEND` (local o voice_live). La única diferencia es que el “cliente” del WebSocket es el puente ACS, no el navegador.

- **Opción B – Puente directo a Voice Live**  
  - ACS → puente → **Voice Live API** (WebSocket).  
  - El agente de conversación y TTS/STT viven en Voice Live; el puente solo inyecta contexto y/o llama a BlindsBook (p. ej. por tools).  
  - En ese caso, nuestro backend puede quedar como “tool server” o no estar en el camino del audio.

En ambos casos, **desde el punto de vista del cliente que llama**, la experiencia es: marcar → escuchar menú de idioma → hablar → escuchar respuestas y crear cita → colgar.

### Paso a paso (producción, con puente a nuestro backend – Opción típica hoy)

1. **Cliente marca** el número configurado en ACS (p. ej. número asociado a una compañía en `PHONE_TO_COMPANY_MAP`).

2. **ACS establece la llamada** y abre un **stream de audio bidireccional** hacia la URL del **puente** (WebSocket que exponemos o que corre en un servicio intermedio).

3. **Puente conecta a Receptionist IA**  
   - El puente abre WebSocket a `wss://tu-servidor/ws/voice`.  
   - Envía `init` con `callerId` (Caller ID de la llamada) y `companyPhone` (número al que se llamó, para elegir compañía).  
   - Mismo flujo que en local: el servidor devuelve el menú de idioma en audio.

4. **Audio bidireccional**  
   - **Teléfono → ACS → puente → nuestro servidor:** el puente envía frames de audio (PCM 16 kHz o el que acepte nuestro protocolo) por el WebSocket (binario o según contrato).  
   - **Nuestro servidor** hace STT (Azure en local, o Voice Live en voice_live), obtiene texto, llama a `handleUserInput`, genera TTS y envía audio por el WebSocket.  
   - **Nuestro servidor → puente → ACS → teléfono:** el cliente escucha la respuesta.

5. **Diálogo y cita**  
   - Igual que en local: identificación por Caller ID, saludo, tipo de cita, fecha, confirmación, `createAppointment` en BlindsBook, despedida.

6. **Cliente cuelga**  
   - ACS detecta fin de llamada; el puente envía `hangup` y cierra el WebSocket; el servidor limpia la sesión.

### Diagrama simplificado (producción con puente a /ws/voice)

```
[Teléfono]  ----  [ACS]  ---- audio bidireccional  ----  [Puente]
                                                              |
                                                              | WebSocket /ws/voice
                                                              v
                                                    [Receptionist IA]
                                                              |
                                    init(callerId, companyPhone), audio, hangup
                                                              |
                                    handleUserInput, BlindsBook API, TTS/STT
                                    (local o Voice Live según VOICE_BACKEND)
```

---

## 3. Dónde se decide el backend de voz

- **Variable de entorno:** `VOICE_BACKEND=local` o `VOICE_BACKEND=voice_live`.  
- **Código:** en `voiceWebSocket.ts`, al crear la sesión se lee `env.voiceBackend` y, si hay credenciales de Voice Live, la sesión puede usar **Voice Live** (STT/TTS y opcionalmente VAD por Voice Live); si no, usa **local** (Azure Speech SDK para STT/TTS).  
- En **local** además puedes elegir en el simulador el backend (Local vs Voice Live) para comparar; en **producción** todas las llamadas usan el mismo `VOICE_BACKEND` configurado en el servidor.

---

## 4. Comandos útiles

- **Reconstruir y levantar Docker (con todo el código actual, incluido Voice Live):**
  ```bash
  cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
  docker compose up -d --build blindsbook-ia
  ```
- **Ver logs del contenedor:**
  ```bash
  docker compose logs -f blindsbook-ia
  ```
- **Probar salud y configuración:**
  ```bash
  curl -s http://localhost:4100/health
  ```
  Ahí verás `voiceLive`, `voiceBackend` y el resto de servicios.

- **Probar flujo local:**  
  Abrir `http://localhost:4100/test/voice-test-v2.html`, elegir backend y hacer una “llamada” de principio a fin.

---

## 5. Referencias

- [Protocolo WebSocket de voz](VOICE_WEBSOCKET_PROTOCOL.md) — mensajes cliente/servidor de `/ws/voice`.
- [Integración ACS + Voice Live](ACS_VOICE_LIVE_INTEGRATION.md) — opciones de puente y Voice Live en producción.
- [Guía de pruebas manuales](GUIA_PRUEBAS_MANUALES.md) — guiones de prueba por escenario.
