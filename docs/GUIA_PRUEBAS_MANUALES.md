# Guía de Pruebas Manuales — Receptionist IA (BlindsBook)

> **Fecha:** Febrero 2026 — Versión 4.0 (Azure OpenAI + Azure Speech)
> **Arquitectura actual:** Node.js slim (~444MB) · Azure OpenAI (LLM) · Azure Speech (TTS) · API BlindsBook (Azure cloud)

---

## Tabla de Contenidos

1. [Paso 1 — Agregar credenciales Azure al .env](#1-paso-1--agregar-credenciales-azure-al-env)
2. [Paso 2 — Reiniciar Docker con las nuevas credenciales](#2-paso-2--reiniciar-docker-con-las-nuevas-credenciales)
3. [Paso 3 — Verificar que todo funciona](#3-paso-3--verificar-que-todo-funciona)
4. [Paso 4 — Abrir la página de pruebas de voz](#4-paso-4--abrir-la-página-de-pruebas-de-voz)
5. [Escenarios de prueba — Identificación de cliente](#5-escenarios-de-prueba--identificación-de-cliente)
6. [Escenarios de prueba — Flujo completo de cita](#6-escenarios-de-prueba--flujo-completo-de-cita)
7. [Escenarios de prueba — Manejo de temas fuera de contexto](#7-escenarios-de-prueba--manejo-de-temas-fuera-de-contexto)
8. [Prueba por texto (PowerShell)](#8-prueba-por-texto-powershell)
9. [Verificar cita creada en el sistema](#9-verificar-cita-creada-en-el-sistema)
10. [Endpoints disponibles](#10-endpoints-disponibles)
11. [Solución de problemas](#11-solución-de-problemas)

---

## 1. Paso 1 — Agregar credenciales Azure al .env

Abre el archivo `.env` en la raíz del proyecto:

```
D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA\.env
```

Busca las secciones **AZURE OPENAI** y **AZURE SPEECH** y rellena las 6 variables:

```env
# ============================
# AZURE OPENAI (LLM PRINCIPAL)
# ============================
AZURE_OPENAI_ENDPOINT=https://TU-RECURSO.openai.azure.com
AZURE_OPENAI_API_KEY=abc123...tu-key-aqui
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
AZURE_OPENAI_API_VERSION=2024-10-21

# ============================
# AZURE SPEECH (TTS NEURONAL)
# ============================
AZURE_SPEECH_KEY=xyz789...tu-key-aqui
AZURE_SPEECH_REGION=eastus
```

> **¿Dónde conseguirlos?** Ver [INFRAESTRUCTURA_AZURE.md](./INFRAESTRUCTURA_AZURE.md)
> — instrucciones paso a paso para crear ambos recursos en Azure Portal.

---

## 2. Paso 2 — Reiniciar Docker con las nuevas credenciales

Abre **PowerShell** y ejecuta:

```powershell
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"

# Detener y levantar de nuevo con el .env actualizado
# (NO necesitas --build — solo cambiaron variables de entorno)
docker compose down
docker compose up -d

# Esperar a que inicie
Start-Sleep -Seconds 8

# Ver que arrancó sin errores
docker compose logs --tail 20 blindsbook-ia
```

> Solo necesitas `--build` si cambias código fuente. Para `.env` basta con `down` + `up -d`.

---

## 3. Paso 3 — Verificar que todo funciona

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/health" | ConvertTo-Json
```

**Respuesta esperada con Azure configurado:**
```json
{
  "ok": true,
  "service": "blindsbook-ia",
  "status": "healthy",
  "llm": "azure-openai",
  "tts": "azure-speech",
  "ocr": "azure-openai-vision + edge-detection"
}
```

Si `"llm"` muestra `"none"`, revisa que las 3 variables `AZURE_OPENAI_*` estén correctas en `.env` y repite el paso 2.

### Probar que el audio TTS funciona

```powershell
Invoke-WebRequest -Uri "http://localhost:4000/debug/play-audio?text=Hola%20bienvenido%20a%20BlindsBook&lang=es" `
  -UseBasicParsing -OutFile "test_audio.mp3"
Start-Process "test_audio.mp3"
# Debes escuchar la voz Elvira (Azure Neural, español)
```

### Verificar que la API BlindsBook responde

```powershell
Invoke-RestMethod "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/health"
# Respuesta: { status: "ok" }
```

> La API BlindsBook vive en Azure cloud — no necesitas levantar nada local.
> Si la primera respuesta tarda ~10 s, es normal (cold start). Las siguientes son inmediatas.

---

## 4. Paso 4 — Abrir la página de pruebas de voz

**URL:** **[http://localhost:4000/test/voice-test.html](http://localhost:4000/test/voice-test.html)**

Abre en **Chrome** o **Edge** (Firefox no soporta Web Speech API).

### Campos de la interfaz

| Campo | Descripción |
|-------|-------------|
| **Compañía** | Determina a qué empresa pertenece la llamada |
| **Caller ID** | Número del que llama — si existe en la BD, identifica al cliente automáticamente |
| **Botón micrófono** | Habla → texto → IA procesa → responde con voz Azure Speech |
| **Nueva conversación** | Reinicia el flujo desde cero |

### Barra de estado (parte inferior)

Muestra en tiempo real: paso actual (`step`), cliente identificado (`customerConfirmedName`, `customerId`), intentos de identificación.

### Compañías y números de prueba

| toNumber (selector) | CompanyId | Compañía | Clientes |
|---|---|---|---|
| `+15550000001` | 2 | All Blinds Inc | ~7,747 |
| `+15550000002` | 163 | Sophie Blinds LLC | ~7,022 |
| `+15550000003` | 387 | Miami's Best Blinds | ~1,258 |

### Caller IDs de prueba

| Teléfono | Resultado esperado |
|----------|-------------------|
| `305-545-2936` | 1 cliente → identificación automática (All Blinds) |
| `+19999999999` | Sin registro → la IA pide el nombre |
| (dejar vacío) | Sin Caller ID → la IA pide el nombre directamente |

---

## 5. Escenarios de prueba — Identificación de cliente

### Escenario A: Caller ID con 1 cliente (identificación automática — Nivel 1)

1. Compañía: **All Blinds Inc**, Caller ID: `305-545-2936`
2. Nueva conversación → di `español` o `1`
3. **Resultado:** La IA saluda por nombre sin hacer preguntas → `step=greeting`

---

### Escenario B: Caller ID con múltiples clientes (desambiguación — Nivel 1)

1. Usa un Caller ID con 2+ clientes registrados bajo el mismo número
2. **Resultado:** La IA lista las opciones y pregunta el nombre
3. Di el número de la lista (`1`, `2`) o di el nombre → confirmación → `step=greeting`

---

### Escenario C: Caller ID no registrado → búsqueda por nombre (Nivel 2)

1. Caller ID: `+19999999999`
2. Di `español`
3. **Resultado:** "No reconozco este número. ¿Me podría dar su nombre completo?"
4. Di un nombre de cliente registrado → la IA lo busca y confirma → `step=greeting`

---

### Escenario D: 3 intentos fallidos → agente LLM (Nivel 3)

1. Caller ID: `+19999999999`
2. Da nombres incorrectos 3 veces
3. **Resultado:** El sistema activa el agente LLM que ofrece registrar al cliente como nuevo o buscarlo por su asesor de ventas

---

## 6. Escenarios de prueba — Flujo completo de cita

### Flujo estándar en español

| # | Tú dices | La IA responde (aproximado) | Paso |
|---|---|---|---|
| 1 | `1` | "Hola [Nombre], ¿en qué le puedo ayudar?" | `greeting` |
| 2 | `quiero agendar una cita` | "¿La visita es para cotización, instalación o reparación?" | `askType` |
| 3 | `cotización` | "Agendaremos una cotización. ¿Para qué fecha?" | `askDate` |
| 4 | `mañana` | "Bien, el [fecha]. ¿A qué hora?" | `askTime` |
| 5 | `a las 10 de la mañana` | "La cita será a las 10:00. La duración estándar es 1 hora. ¿Le parece bien?" | `askDuration` |
| 6 | `sí` | Resumen de la cita completo. "¿Está correcto?" | `confirmSummary` |
| 7 | `sí` | "¡Su cita ha sido registrada exitosamente! Hasta luego." | `completed` ✅ |

### Flujo en inglés

Selecciona idioma con `2` o diciendo `English`. Los pasos son iguales en inglés y se usa la voz `JennyNeural`.

### Fecha con hora incluida (salta `askTime`)

Si en el paso de fecha dices `mañana a las 3 de la tarde`, la IA extrae ambos datos y va directo a preguntar la duración.

### Cancelar y empezar de nuevo

En `confirmSummary` di `no` → la IA reinicia desde el tipo de cita.

---

## 7. Escenarios de prueba — Manejo de temas fuera de contexto

El LLM entiende preguntas que no corresponden al paso actual y responde brevemente antes de retomar el flujo. Prueba estos casos:

| Durante este paso | Di algo fuera de tema | Resultado esperado |
|---|---|---|
| `askType` | "¿Cuánto cuestan las cortinas?" | La IA responde y vuelve a preguntar el tipo |
| `askDate` | "¿Tienen garantía en los productos?" | La IA responde y redirige a elegir fecha |
| `askTime` | "¿Puedo ir en persona a la tienda?" | La IA responde y solicita la hora de nuevo |
| `confirmSummary` | "Espera, ¿puedo cambiar la fecha?" | La IA sugiere decir "no" para empezar de nuevo |
| `askCustomerName` | "¿Hacen instalaciones en Miami?" | La IA responde y vuelve a pedir el nombre |

---

## 8. Prueba por texto (PowerShell)

Para probar sin micrófono mediante scripts:

```powershell
$callId = "test-$(Get-Date -Format 'HHmmss')"

function Chat($texto, $desde = $null) {
    $payload = @{ callId = $callId; text = $texto; toNumber = "+15550000001" }
    if ($desde) { $payload.fromNumber = $desde }
    $r = Invoke-RestMethod -Uri "http://localhost:4000/debug/chat" -Method POST `
         -ContentType "application/json" -Body ($payload | ConvertTo-Json)
    Write-Host "IA: $($r.replyText)" -ForegroundColor Cyan
    return $r
}

# Flujo completo con identificación automática
Chat $null "+13055452936"    # Saludo inicial con Caller ID
Chat "1"                      # Seleccionar español
Chat "quiero una cita"        # Expresar intención
Chat "cotización"             # Tipo de cita
Chat "mañana a las 3"         # Fecha y hora juntas
Chat "está bien"              # Confirmar duración (1 hora)
Chat "sí"                     # Confirmar resumen
```

Para incluir audio en la respuesta, usa `/debug/voice-chat` en lugar de `/debug/chat`.

---

## 9. Verificar cita creada en el sistema

```powershell
# Login
$loginBody = @{ email = "ai_agent_callcenter@blindsbook.com"; password = "chongo70428" } | ConvertTo-Json
$login = Invoke-RestMethod `
  -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/auth/login" `
  -Method POST -Body $loginBody -ContentType "application/json"
$headers = @{ Authorization = "Bearer $($login.data.token)" }

# Últimas 5 citas creadas
Invoke-RestMethod `
  -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/appointments?page=1&pageSize=5" `
  -Headers $headers | ConvertTo-Json -Depth 4
```

---

## 10. Endpoints disponibles

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/health` | Estado del servicio: `llm`, `tts`, `ocr` |
| `GET`  | `/test/voice-test.html` | 🎤 **Página de pruebas con micrófono** |
| `POST` | `/debug/chat` | Diálogo solo texto (sin audio, más rápido) |
| `POST` | `/debug/voice-chat` | Diálogo + audio TTS (`audioBase64` incluido) |
| `GET`  | `/debug/play-audio?text=X&lang=es` | Genera MP3 con Azure Speech |
| `GET`  | `/debug/customer-lookup?phone=X` | Busca clientes por teléfono |
| `POST` | `/ocr/window-frame` | Detecta marco de ventana (Azure Vision → edge-detection) |
| `POST` | `/twilio/voice-webhook` | Webhook para Twilio en producción |

---

## 11. Solución de problemas

### `"llm": "none"` en el health check

Las variables de Azure OpenAI no están llegando al contenedor.

```powershell
# Verificar que el contenedor tiene las variables
docker compose exec blindsbook-ia printenv | Select-String "AZURE_OPENAI"
# Si aparecen vacías: edita .env, luego docker compose down && docker compose up -d
```

### `"tts": "twilio-say-fallback"` (sin voz Azure)

El sistema funciona igual pero usa la voz sintética de Twilio como respaldo.

```powershell
docker compose exec blindsbook-ia printenv | Select-String "AZURE_SPEECH"
# Verificar que AZURE_SPEECH_KEY y AZURE_SPEECH_REGION tienen valor
```

### La IA no encuentra al cliente

La API BlindsBook puede tener cold start. Espera 15 s y reintenta.

```powershell
Invoke-RestMethod "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/health"
docker compose logs --tail 20 blindsbook-ia | Select-String "TokenManager|Error"
```

### El navegador no escucha el micrófono

- Usa **Chrome** o **Edge** (no Firefox, no Safari)
- Accede por `http://localhost` exactamente (no por IP)
- Haz clic en el candado de la barra de URL → Micrófono → Permitir

### Comandos Docker de referencia

```powershell
# Ver estado
docker compose ps

# Logs en tiempo real
docker compose logs -f blindsbook-ia

# Aplicar cambios del .env (sin rebuild)
docker compose down ; docker compose up -d

# Rebuild completo (solo si cambiaste código fuente)
docker compose up -d --build

# Uso de recursos
docker stats blindsbook-ia --no-stream
```

---

## Resumen — checklist de inicio

```
[ ] 1. Editar .env → rellenar AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY,
       AZURE_OPENAI_DEPLOYMENT, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION

[ ] 2. PowerShell:
       cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
       docker compose down ; docker compose up -d

[ ] 3. Verificar:
       Invoke-RestMethod http://localhost:4000/health
       → "llm": "azure-openai"  ✅
       → "tts": "azure-speech"  ✅

[ ] 4. Abrir Chrome:
       http://localhost:4000/test/voice-test.html

[ ] 5. Probar los escenarios de esta guía
```

---
## 16. Guion de Pruebas Paso a Paso (con numeros reales)

> **Instrucciones:** Lee cada guion en orden. Abre `http://localhost:4000/test/voice-test.html`.
> Puedes usar **modo Voz** (microfono) o **modo Texto** (escribir). Si Edge da error de red
> en modo Voz, el sistema cambiara automaticamente a modo Texto.
> Marca [x] en cada paso que funcione correctamente.

---

### GUION 1: Identificacion automatica por Caller ID (match unico, espanol)

**Cliente:** Maria Elena Rodriguez — Tel: `305-545-2936` — Compania 2 (All Blinds Inc)

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Buscar cliente | Escribir `305-545-2936` en busqueda → Buscar | Tarjeta: Maria Elena Rodriguez, Compania 2 | [ ] |
| 2 | Verificar auto-config | — | Compania = All Blinds Inc, Caller ID = 305-545-2936 | [ ] |
| 3 | Seleccionar idioma | Click en **Espanol — Presione 1** | Se envia saludo + idioma, IA responde con identificacion | [ ] |
| 4 | Verificar identificacion | — | IA dice "Hola Maria Elena!" o similar, step=greeting | [ ] |
| 5 | Estado | Revisar barra inferior | customerId con valor, customerConfirmedName con nombre | [ ] |

**Resultado esperado:** Identificacion automatica sin preguntar nombre. Directo a greeting.

---

### GUION 2: Identificacion automatica (match unico, ingles)

**Cliente:** Brian Williams — Tel: `786-853-4538` — Compania 2 (All Blinds Inc)

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Se resetea todo | [ ] |
| 2 | Buscar cliente | Escribir `786-853-4538` → Buscar | Tarjeta: Brian Williams, Compania 2 | [ ] |
| 3 | Seleccionar idioma | Click en **English — Press 2** | IA identifica y saluda en ingles: "Hello Brian!" | [ ] |
| 4 | Verificar idioma | Revisar barra inferior | Lang: en | [ ] |
| 5 | Pedir cita | Decir/escribir: `I need an appointment` | "Is this for a quote, installation, or repair?" | [ ] |

**Resultado esperado:** Flujo completo en ingles con cliente anglosajon.

---

### GUION 3: Telefono no registrado → Nivel 2 (pedir nombre)

**Telefono FALSO:** `999-999-9999` — No existe en ninguna compania

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Se resetea | [ ] |
| 2 | Config manual | Seleccionar Compania 2 en dropdown. Escribir `999-999-9999` en Caller ID | — | [ ] |
| 3 | Seleccionar idioma | Click en **Espanol — Presione 1** | IA dice: "No reconozco este numero. Me podria dar su nombre?" | [ ] |
| 4 | Verificar estado | Revisar barra | step=askCustomerName | [ ] |
| 5 | Dar nombre real | Escribir: `Maria Elena Rodriguez` | "Encontre a Maria Elena Rodriguez. Es usted?" | [ ] |
| 6 | Confirmar | Escribir: `si` | "Perfecto, Maria Elena Rodriguez. En que puedo ayudarle?" | [ ] |
| 7 | Verificar estado | Revisar barra | step=greeting, customerId con valor | [ ] |

**Resultado esperado:** Nivel 1 falla → pasa a Nivel 2 → busca por nombre → confirma identidad.

---

### GUION 4: Nombre comun con multiples resultados (desambiguacion)

**Cliente:** JORGE LOPEZ — Tel: `786-239-4584` — Compania 2

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Se resetea | [ ] |
| 2 | Config manual | Compania 2, Caller ID: `999-888-7777` (falso) | — | [ ] |
| 3 | Seleccionar idioma | Click en **Espanol** | "No reconozco. Me podria dar su nombre?" | [ ] |
| 4 | Dar nombre comun | Escribir: `Jorge Lopez` | Si hay multiples: "Encontre varios clientes: 1. Jorge Lopez (tel. ***4584)..." | [ ] |
| 5a | Elegir por numero | Escribir: `1` | "Perfecto, Jorge Lopez." → step=greeting | [ ] |
| 5b | (Alternativa) Si match unico | — | "Encontre a Jorge Lopez. Es usted?" → escribir "si" | [ ] |

**Resultado esperado:** Nombre comun puede dar multi-match → desambiguacion o match unico.

---

### GUION 5: 3 intentos fallidos → Nivel 3 LLM

**Compania 2** — Caller ID falso

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion + config | Compania 2, Caller ID: `999-111-2222` | — | [ ] |
| 2 | Seleccionar idioma | Click **Espanol** | "No reconozco. Me podria dar su nombre?" | [ ] |
| 3 | Intento fallido 1 | Escribir: `ZZZZZZ XXXXXX` | "No encontre a ZZZZZZ XXXXXX. Podria intentar con otro nombre?" | [ ] |
| 4 | Intento fallido 2 | Escribir: `YYYYYY WWWWWW` | "No encontre a YYYYYY WWWWWW..." | [ ] |
| 5 | Intento fallido 3 | Escribir: `AAAAAA BBBBBB` | Pasa a Nivel 3: "No pude encontrarlo. Recuerda el nombre de su vendedor?" | [ ] |
| 6 | Verificar estado | Revisar barra | step=llmFallback, identificationAttempts=3 | [ ] |
| 7 | Indicar cliente nuevo | Escribir: `Es mi primera vez` | LLM: "Le gustaria que lo registre como cliente nuevo?" | [ ] |
| 8 | Dar nombre nuevo | Escribir: `Roberto Gonzalez` | LLM crea cliente → paso a greeting | [ ] |

**Resultado esperado:** 3 fallos → Nivel 3 → registro de cliente nuevo via LLM.

---

### GUION 6: Sin Caller ID → pide nombre directo

**Compania 163 (Sophie Blinds LLC)** — Sin Caller ID

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Se resetea | [ ] |
| 2 | Config manual | Compania 163, **borrar** el campo Caller ID (dejar vacio) | — | [ ] |
| 3 | Seleccionar idioma | Click **Espanol** | "Bienvenido a BlindsBook. Me podria dar su nombre o telefono?" | [ ] |
| 4 | Dar nombre | Escribir: `Mabel Mendoza` | "Encontre a Mabel Mendoza. Es usted?" | [ ] |
| 5 | Confirmar | Escribir: `si` | "Perfecto, Mabel Mendoza." → step=greeting | [ ] |

**Resultado esperado:** Sin caller phone → directo a Nivel 2 → busca por nombre.

---

### GUION 7: Compania diferente (Sophie Blinds LLC, compania 163)

**Cliente:** PAULINO HERNANDEZ — Tel: `786-236-0929` — Compania 163

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Se resetea | [ ] |
| 2 | Buscar cliente | Escribir `786-236-0929` → Buscar | Tarjeta: PAULINO HERNANDEZ, Compania 163 | [ ] |
| 3 | Verificar auto-config | — | Compania = Sophie Blinds LLC (+15550000002), Caller ID = 786-236-0929 | [ ] |
| 4 | Seleccionar idioma | Click **Espanol** | IA identifica: "Hola Paulino!" | [ ] |
| 5 | Verificar multi-tenant | Revisar barra | customerId con valor correcto para compania 163 | [ ] |

**Resultado esperado:** El sistema busca en la compania correcta (163, no 2).

---

### GUION 8: Flujo COMPLETO de cita (identificacion → cita creada)

**Cliente:** Diosdado Fernandez — Tel: `305-362-1270` — Compania 2

| Paso | Accion | Que escribir / decir | Respuesta esperada | Step | OK? |
|---|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Reset | — | [ ] |
| 2 | Buscar cliente | `305-362-1270` → Buscar | Tarjeta: Diosdado Fernandez | — | [ ] |
| 3 | Seleccionar idioma | Click **Espanol** | "Hola Diosdado!" | greeting | [ ] |
| 4 | Pedir cita | `quiero agendar una cita` | "Es para cotizacion, instalacion o reparacion?" | askType | [ ] |
| 5 | Tipo | `cotizacion` | "Perfecto, agendaremos cotizacion. Para que fecha?" | askDate | [ ] |
| 6 | Fecha | `manana` | "Para el [fecha]. A que hora?" | askTime | [ ] |
| 7 | Hora | `a las 10 de la manana` | "Cita el [fecha] 10:00. Duracion 1 hora. Esta bien?" | askDuration | [ ] |
| 8 | Duracion | `si` | Resumen completo: Tipo, Cliente, Fecha, Hora, Duracion. "Correcto?" | confirmSummary | [ ] |
| 9 | Confirmar | `si` | "Su cita ha sido registrada exitosamente." | completed | [ ] |
| 10 | Verificar tarjeta | Revisar customer card | Debe mostrar: TIPO CITA, FECHA CITA, NOMBRE CONFIRMADO en verde | — | [ ] |

**Resultado esperado:** Flujo completo desde identificacion hasta creacion de cita en la BD.

---

### GUION 9: Flujo completo en INGLES

**Cliente:** Althea Mcmillan — Tel: `305-904-2387` — Compania 2

| Paso | Accion | Que escribir / decir | Respuesta esperada | Step | OK? |
|---|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Reset | — | [ ] |
| 2 | Buscar cliente | `305-904-2387` → Buscar | Tarjeta: Althea Mcmillan | — | [ ] |
| 3 | Seleccionar idioma | Click **English — Press 2** | "Hello Althea!" | greeting | [ ] |
| 4 | Pedir cita | `I need to schedule an appointment` | "Is this for a quote, installation, or repair?" | askType | [ ] |
| 5 | Tipo | `installation` | "We'll schedule an installation. What date?" | askDate | [ ] |
| 6 | Fecha y hora | `next Monday at 2 PM` | "Appointment on [date] 2:00 PM. Duration 1 hour. OK?" | askDuration | [ ] |
| 7 | Confirmar duracion | `yes` | Resumen en ingles. "Is this correct?" | confirmSummary | [ ] |
| 8 | Confirmar | `yes` | "Your appointment has been registered." | completed | [ ] |

**Resultado esperado:** Todo el flujo en ingles, fecha+hora combinadas saltan askTime.

---

### GUION 10: Area code diferente (954 — Broward) y cancelar cita

**Cliente:** SONIA IGLESIAS — Tel: `954-438-4043` — Compania 2

| Paso | Accion | Que escribir / decir | Respuesta esperada | Step | OK? |
|---|---|---|---|---|---|
| 1 | Nueva conversacion | Click **Nueva conversacion** | Reset | — | [ ] |
| 2 | Buscar cliente | `954-438-4043` → Buscar | Tarjeta: SONIA IGLESIAS, Compania 2 | — | [ ] |
| 3 | Seleccionar idioma | Click **Espanol** | "Hola Sonia!" | greeting | [ ] |
| 4 | Pedir cita | `necesito una cita` | "Cotizacion, instalacion o reparacion?" | askType | [ ] |
| 5 | Tipo | `reparacion` | "Agendaremos reparacion. Para que fecha?" | askDate | [ ] |
| 6 | Fecha | `el viernes` | "Para el [viernes]. A que hora?" | askTime | [ ] |
| 7 | Hora | `a las 3` | Resumen parcial. "Duracion 1 hora. Esta bien?" | askDuration | [ ] |
| 8 | Duracion | `si` | Resumen completo. "Correcto?" | confirmSummary | [ ] |
| 9 | **CANCELAR** | `no` | "De acuerdo, empecemos de nuevo. Cotizacion, instalacion o reparacion?" | askType | [ ] |
| 10 | Verificar | — | El flujo vuelve a askType, NO se creo cita | — | [ ] |

**Resultado esperado:** Area code 954 funciona. Al decir "no" en confirmacion, vuelve al inicio del flujo de cita.

---

### GUION 11: Area code fuera de Florida (404 — Atlanta)

**Cliente:** Russ Nordahl — Tel: `404-384-2663` — Compania 163

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion + Buscar | `404-384-2663` → Buscar | Tarjeta: Russ Nordahl, Compania 163 | [ ] |
| 2 | Seleccionar idioma | Click **English** | "Hello Russ!" | [ ] |
| 3 | Verificar | Revisar barra | step=greeting, customerId con valor | [ ] |

**Resultado esperado:** Telefonos de fuera de Florida (area code 404) funcionan igual.

---

### GUION 12: Apellido dificil de pronunciar (test de voz)

**Cliente:** BLAKE LICKTEIG — Tel: `305-522-1365` — Compania 163

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Nueva conversacion + Buscar | `305-522-1365` → Buscar | Tarjeta: BLAKE LICKTEIG, Compania 163 | [ ] |
| 2 | Seleccionar idioma | Click **English** | "Hello Blake!" (o "Blake Lickteig") | [ ] |
| 3 | Verificar por voz | Escuchar audio TTS | La IA pronuncia el nombre correctamente | [ ] |

**Resultado esperado:** El TTS pronuncia el apellido de forma inteligible.

---

### GUION 13: Busqueda de cliente que aparece en 2 companias

**Telefono:** `305-323-2397` (Mabel Mendoza en compania 163)

| Paso | Accion | Que escribir / decir | Respuesta esperada | OK? |
|---|---|---|---|---|
| 1 | Buscar | `305-323-2397` → Buscar | Muestra resultado. Verificar: totalResults y companias buscadas | [ ] |
| 2 | Verificar | — | Si aparece en mas de 1 compania, la tarjeta muestra el primer resultado | [ ] |
| 3 | Verificar auto-config | — | toNumber debe ser +15550000002 (compania 163) | [ ] |

---

### Resumen de cobertura

| Guion | Nivel | Escenario | Cliente | Telefono |
|---|---|---|---|---|
| 1 | Nivel 1 | Match unico, espanol | Maria Elena Rodriguez | `305-545-2936` |
| 2 | Nivel 1 | Match unico, ingles | Brian Williams | `786-853-4538` |
| 3 | Nivel 2 | Telefono falso → buscar por nombre | Maria Elena Rodriguez | `999-999-9999` |
| 4 | Nivel 2 | Nombre comun, desambiguacion | Jorge Lopez | `786-239-4584` |
| 5 | Nivel 3 | 3 fallos → LLM → cliente nuevo | (nuevo) | `999-111-2222` |
| 6 | Nivel 2 | Sin Caller ID | Mabel Mendoza | (vacio) |
| 7 | Nivel 1 | Multi-tenant (compania 163) | Paulino Hernandez | `786-236-0929` |
| 8 | Completo | Cita completa espanol | Diosdado Fernandez | `305-362-1270` |
| 9 | Completo | Cita completa ingles | Althea Mcmillan | `305-904-2387` |
| 10 | Completo | Cancelar y reiniciar cita | Sonia Iglesias | `954-438-4043` |
| 11 | Nivel 1 | Area code fuera de FL | Russ Nordahl | `404-384-2663` |
| 12 | Nivel 1 | Apellido dificil (TTS) | Blake Lickteig | `305-522-1365` |
| 13 | Busqueda | Multi-compania lookup | Mabel Mendoza | `305-323-2397` |

*Última actualización: Febrero 2026*

