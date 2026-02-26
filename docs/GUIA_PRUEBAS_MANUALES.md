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
> Puedes usar **modo Voz** (microfono) o **modo Texto** (escribir).
> En cada guion encontraras:
> - **Configuracion:** que poner en los campos antes de iniciar
> - **Dialogo esperado:** la conversacion completa con lo que dice la IA y lo que debes responder
> - **Verificacion:** que comprobar al final
>
> Leyenda: 🤖 = lo que dice la IA | 🧑 = lo que tu dices/escribes | ✅ = estado esperado en la barra inferior

---

### GUION 1: Identificacion automatica por Caller ID (match unico, espanol)

**Cliente:** Maria Elena Rodriguez — Tel: `305-545-2936` — Compania 2 (All Blinds Inc)

**Configuracion antes de iniciar:**
1. Escribir `305-545-2936` en el campo de busqueda y hacer clic en **Buscar**
2. La tarjeta debe mostrar: *Maria Elena Rodriguez, Compania 2 (All Blinds Inc)*
3. Los campos se autocompletan: Compania = `+15550000001`, Caller ID = `305-545-2936`
4. Hacer clic en **Llamar** para iniciar la sesion

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en el boton **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"¡Hola, María Elena! Bienvenida de nuevo a BlindsBook. ¿En qué le puedo ayudar hoy?"*

**Verificacion:**
- ✅ `step = greeting` — la IA fue directo a saludar sin pedir nombre
- ✅ `customerId` tiene un valor numerico
- ✅ `customerConfirmedName = Maria Elena Rodriguez`
- ✅ No hubo ningun paso intermedio de identificacion

---

### GUION 2: Identificacion automatica (match unico, ingles)

**Cliente:** Brian Williams — Tel: `786-853-4538` — Compania 2 (All Blinds Inc)

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion** para resetear
2. Buscar `786-853-4538` → tarjeta: *Brian Williams, Compania 2*
3. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Welcome to BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en el boton **🇺🇸 English — Press 2**)*

> 🤖 IA: *"Hello, Brian! Welcome back to BlindsBook. How can I help you today?"*

> 🧑 Tu: `I need to schedule an appointment`

> 🤖 IA: *"Of course! Is this visit for a quote, an installation, or a repair?"*

**Verificacion:**
- ✅ `lang = en` en la barra de estado
- ✅ `step = askType`
- ✅ `customerId` con valor — identificacion automatica sin pedir nombre
- ✅ Toda la conversacion en ingles

---

### GUION 3: Telefono no registrado → Nivel 2 (pedir nombre, 1 resultado)

**Cliente real al que se quiere llegar:** Maria Elena Rodriguez — Compania 2
**Telefono simulado (falso):** `999-999-9999`

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. En el dropdown de compania seleccionar **All Blinds Inc (+15550000001)**
3. En el campo Caller ID escribir manualmente `999-999-9999`
4. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"Bienvenido. No reconozco este número. ¿Me podría dar su nombre completo o el teléfono con el que está registrado?"*

> 🧑 Tu: `Maria Elena Rodriguez`

> 🤖 IA: *"Encontré a María Elena Rodríguez. ¿Es usted?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Perfecto, María Elena. ¿En qué le puedo ayudar hoy?"*

**Verificacion:**
- ✅ `step = greeting`
- ✅ `customerId` con valor
- ✅ `identificationAttempts = 1`

---

### GUION 4: Nombre comun con multiples resultados (desambiguacion)

**Cliente real:** Jorge Lopez — Tel real: `786-239-4584` — Compania 2
**Caller ID simulado:** `999-888-7777` (falso, para forzar busqueda por nombre)

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Compania: **All Blinds Inc (+15550000001)**
3. Caller ID: `999-888-7777`
4. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"Bienvenido. No reconozco este número. ¿Me podría dar su nombre completo?"*

> 🧑 Tu: `Jorge Lopez`

*(Si hay multiples Jorge Lopez en la compania:)*

> 🤖 IA: *"Encontré varios clientes con ese nombre. ¿Podría decirme cuál es usted? 1. Jorge Lopez, teléfono terminado en 4584. 2. Jorge Lopez, teléfono terminado en 2390."*

> 🧑 Tu: `1`

> 🤖 IA: *"Perfecto, Jorge López. ¿En qué le puedo ayudar hoy?"*

*(Si solo hay un Jorge Lopez en la compania:)*

> 🤖 IA: *"Encontré a Jorge López. ¿Es usted?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Perfecto, Jorge. ¿En qué le puedo ayudar?"*

**Verificacion:**
- ✅ `step = greeting`
- ✅ `customerId` con valor correcto para Jorge Lopez

---

### GUION 5: 3 intentos fallidos → Nivel 3 LLM (cliente nuevo)

**Compania:** All Blinds Inc — Caller ID falso: `999-111-2222`

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Compania: **All Blinds Inc (+15550000001)**
3. Caller ID: `999-111-2222`
4. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"Bienvenido. No reconozco este número. ¿Me podría dar su nombre completo?"*

> 🧑 Tu: `ZZZZZZ XXXXXX`

> 🤖 IA: *"No encontré a ZZZZZZ XXXXXX en nuestro sistema. ¿Podría intentarlo con otro nombre o número de teléfono?"*

> 🧑 Tu: `YYYYYY WWWWWW`

> 🤖 IA: *"Tampoco encontré ese nombre. ¿Tiene otro teléfono o nombre con el que podría estar registrado?"*

> 🧑 Tu: `AAAAAA BBBBBB`

*(Despues del 3er intento fallido, activa Nivel 3 LLM)*

> 🤖 IA: *"No he podido encontrarle con la información proporcionada. ¿Recuerda el nombre de su asesor de ventas, o es la primera vez que nos contacta?"*

> 🧑 Tu: `Es mi primera vez, nunca he llamado antes`

> 🤖 IA: *"Entendido. ¿Le gustaría que lo registre como cliente nuevo? Necesitaría su nombre completo."*

> 🧑 Tu: `Sí, me llamo Roberto Gonzalez`

> 🤖 IA: *"Perfecto, Roberto González. Le he registrado en nuestro sistema. ¿En qué le puedo ayudar hoy?"*

**Verificacion:**
- ✅ `step = llmFallback` — activado en el 3er intento
- ✅ Al dar nombre nuevo, `step = greeting` con nuevo `customerId`
- ✅ `identificationAttempts = 3`

---

### GUION 6: Sin Caller ID → pide nombre directo

**Cliente real:** Mabel Mendoza — Compania 163 (Sophie Blinds LLC)
**Caller ID:** vacio (sin numero)

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Compania: **Sophie Blinds LLC (+15550000002)**
3. Campo Caller ID: **borrar completamente** (dejar en blanco)
4. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"Bienvenido a BlindsBook. ¿Me podría dar su nombre completo o el número de teléfono con el que está registrado?"*

> 🧑 Tu: `Mabel Mendoza`

> 🤖 IA: *"Encontré a Mabel Mendoza. ¿Es usted?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Perfecto, Mabel. ¿En qué le puedo ayudar hoy?"*

**Verificacion:**
- ✅ Sin Caller ID → va directo a Nivel 2 (pedir nombre), no intenta Nivel 1
- ✅ `step = greeting`
- ✅ `customerId` con valor para compania 163

---

### GUION 7: Multi-tenant — Compania 163 (Sophie Blinds LLC)

**Cliente:** Paulino Hernandez — Tel: `786-236-0929` — Compania 163

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Buscar `786-236-0929` → tarjeta: *Paulino Hernandez, Compania 163*
3. Verificar que el dropdown cambia automaticamente a **Sophie Blinds LLC (+15550000002)**
4. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"¡Hola, Paulino! Bienvenido a BlindsBook. ¿En qué le puedo ayudar?"*

**Verificacion:**
- ✅ El sistema identifico al cliente de la compania 163, NO de la compania 2
- ✅ `customerId` corresponde a Paulino Hernandez en compania 163
- ✅ `step = greeting` — identificacion automatica

---

### GUION 8: Flujo COMPLETO de cita — espanol (identificacion → cita creada en BD)

**Cliente:** Diosdado Fernandez — Tel: `305-362-1270` — Compania 2

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Buscar `305-362-1270` → verificar tarjeta: *Diosdado Fernandez, Compania 2*
3. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"¡Hola, Diosdado! Bienvenido de nuevo a BlindsBook. ¿En qué le puedo ayudar hoy?"*

> 🧑 Tu: `quiero agendar una cita`

> 🤖 IA: *"Con gusto le ayudo. ¿La visita sería para una cotización, una instalación o una reparación?"*

> 🧑 Tu: `cotización`

> 🤖 IA: *"Perfecto, agendaremos una cotización. ¿Para qué fecha le vendría bien?"*

> 🧑 Tu: `mañana`

> 🤖 IA: *"Muy bien, para el [fecha de mañana]. ¿A qué hora le gustaría la cita?"*

> 🧑 Tu: `a las 10 de la mañana`

> 🤖 IA: *"La cita sería el [fecha] a las 10:00 AM. La duración estándar es 1 hora. ¿Le parece bien?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Perfecto. Déjeme confirmar: Cotización para Diosdado Fernández el [fecha] a las 10:00 AM, duración 1 hora. ¿Está todo correcto?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"¡Excelente! Su cita ha sido registrada exitosamente. ¡Que tenga un excelente día, Diosdado!"*

**Verificacion:**
- ✅ `step = completed` — flujo terminado
- ✅ La tarjeta de cliente muestra TIPO CITA, FECHA CITA en verde
- ✅ Ejecutar `node scripts/check-appointments.cjs --last 1` en terminal — debe aparecer la cita con `CreatedBy: ai_agent_callcenter@blindsbook.com`

---

### GUION 9: Flujo completo en INGLES (fecha y hora en un solo turno)

**Cliente:** Althea Mcmillan — Tel: `305-904-2387` — Compania 2

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Buscar `305-904-2387` → verificar tarjeta: *Althea Mcmillan, Compania 2*
3. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Welcome to BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇺🇸 English — Press 2**)*

> 🤖 IA: *"Hello, Althea! Welcome back to BlindsBook. How can I help you today?"*

> 🧑 Tu: `I need to schedule an appointment`

> 🤖 IA: *"Of course! Is this visit for a quote, an installation, or a repair?"*

> 🧑 Tu: `installation`

> 🤖 IA: *"Great, we'll schedule an installation. What date works for you?"*

> 🧑 Tu: `next Monday at 2 PM`

*(La IA detecta fecha y hora juntas, salta el paso askTime)*

> 🤖 IA: *"Perfect, next Monday at 2:00 PM. The standard duration is 1 hour. Does that work for you?"*

> 🧑 Tu: `yes`

> 🤖 IA: *"Let me confirm: Installation for Althea McMillan on [date] at 2:00 PM, 1 hour. Is everything correct?"*

> 🧑 Tu: `yes`

> 🤖 IA: *"Your appointment has been successfully registered. Have a wonderful day, Althea!"*

**Verificacion:**
- ✅ `step = completed`
- ✅ `lang = en` en todo el flujo
- ✅ El paso `askTime` NO aparecio (fecha y hora se dieron juntas)
- ✅ Verificar con `node scripts/check-appointments.cjs --last 1`

---

### GUION 10: Cancelar en confirmacion y reiniciar — area code 954

**Cliente:** Sonia Iglesias — Tel: `954-438-4043` — Compania 2

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Buscar `954-438-4043` → verificar tarjeta: *Sonia Iglesias, Compania 2*
3. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"¡Hola, Sonia! Bienvenida a BlindsBook. ¿En qué le puedo ayudar?"*

> 🧑 Tu: `necesito una cita`

> 🤖 IA: *"¿La visita es para cotización, instalación o reparación?"*

> 🧑 Tu: `reparación`

> 🤖 IA: *"Muy bien. ¿Para qué fecha necesita la reparación?"*

> 🧑 Tu: `el viernes`

> 🤖 IA: *"Para el viernes [fecha]. ¿A qué hora le vendría bien?"*

> 🧑 Tu: `a las 3 de la tarde`

> 🤖 IA: *"El viernes a las 3:00 PM. La duración estándar es 1 hora. ¿Le parece bien?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Perfecto. Reparación para Sonia Iglesias el [viernes] a las 3:00 PM, 1 hora. ¿Está correcto?"*

> 🧑 Tu: `no, quiero cambiarlo`

> 🤖 IA: *"De acuerdo, empecemos de nuevo. ¿La visita sería para cotización, instalación o reparación?"*

*(El flujo vuelve a askType — NO se creo ninguna cita)*

> 🧑 Tu: `cotización`

> 🤖 IA: *"Agendaremos una cotización. ¿Para qué fecha?"*

> 🧑 Tu: `el lunes`

> 🤖 IA: *"Para el lunes [fecha]. ¿A qué hora?"*

> 🧑 Tu: `a las 11`

> 🤖 IA: *"El lunes a las 11:00 AM, 1 hora. ¿Le parece bien?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Cotización para Sonia Iglesias el [lunes] a las 11:00 AM, 1 hora. ¿Está correcto?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"¡Su cita ha sido registrada exitosamente! Que tenga un buen día, Sonia."*

**Verificacion:**
- ✅ Al decir "no" en confirmacion, el flujo volvio a `askType` sin crear cita
- ✅ La segunda cita (cotizacion del lunes) SI se creo en la BD
- ✅ `step = completed`

---

### GUION 11: Area code fuera de Florida (404 — Atlanta)

**Cliente:** Russ Nordahl — Tel: `404-384-2663` — Compania 163

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Buscar `404-384-2663` → verificar tarjeta: *Russ Nordahl, Compania 163 (Sophie Blinds LLC)*
3. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Welcome to BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇺🇸 English — Press 2**)*

> 🤖 IA: *"Hello, Russ! Welcome back to BlindsBook. How can I help you today?"*

> 🧑 Tu: `I'd like to schedule a quote`

> 🤖 IA: *"Of course! What date works for you?"*

> 🧑 Tu: `this Friday`

> 🤖 IA: *"This Friday [date]. What time would you prefer?"*

> 🧑 Tu: `at 9 in the morning`

> 🤖 IA: *"Friday at 9:00 AM, 1 hour. Does that work for you?"*

> 🧑 Tu: `yes`

> 🤖 IA: *"Quote for Russ Nordahl on [Friday] at 9:00 AM. Is everything correct?"*

> 🧑 Tu: `yes`

> 🤖 IA: *"Your appointment has been registered. Have a great day, Russ!"*

**Verificacion:**
- ✅ Area code 404 (fuera de FL) no causa ningun problema
- ✅ Cliente de compania 163 correctamente identificado
- ✅ `step = completed`

---

### GUION 12: Apellido dificil de pronunciar — test de calidad TTS

**Cliente:** Blake Lickteig — Tel: `305-522-1365` — Compania 163

> **Objetivo:** Verificar que la voz Azure Speech Neural pronuncia correctamente nombres y apellidos inusuales.

**Configuracion antes de iniciar:**
1. Click en **Nueva conversacion**
2. Buscar `305-522-1365` → verificar tarjeta: *Blake Lickteig, Compania 163*
3. Asegurarse de tener audio/parlantes activos
4. Click en **Llamar**

**Dialogo esperado:**

> 🤖 IA: *"Welcome to BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇺🇸 English — Press 2**)*

> 🤖 IA: *"Hello, Blake! Welcome back to BlindsBook. How can I help you today?"*
> *(Escuchar: ¿pronuncia "Lick-tig" de forma inteligible? ¿El saludo suena natural?)*

> 🧑 Tu: `just checking in`

> 🤖 IA: *"Of course! Is there anything I can help you with today, like scheduling a quote, installation, or repair?"*

**Verificacion:**
- ✅ La voz Azure Neural pronuncia "Blake" claramente
- ✅ El apellido "Lickteig" en la frase de saludo es inteligible (Azure hace un intento razonable)
- ✅ La velocidad de la voz es natural (no acelerada, no lenta)
- ✅ Las pausas entre oraciones suenan naturales

---

### GUION 13: Cliente registrado en 2 companias — verificar busqueda correcta

**Telefono:** `305-323-2397` — Mabel Mendoza aparece en compania 163

**Objetivo:** Verificar que la busqueda por telefono devuelve el cliente y configura la compania correcta.

**Pasos de verificacion inicial (antes de llamar):**
1. Escribir `305-323-2397` en busqueda
2. Click en **Buscar**
3. Leer la tarjeta resultante: ¿Que compania aparece? ¿Cual es el `toNumber` que se autocompleto?

**Dialogo esperado (una vez configurado con compania 163):**

> 🤖 IA: *"Bienvenido a BlindsBook. Para español presione 1, for English press 2."*

> 🧑 Tu: *(Click en **🇪🇸 Español — Presione 1**)*

> 🤖 IA: *"¡Hola, Mabel! Bienvenida a BlindsBook. ¿En qué le puedo ayudar hoy?"*

> 🧑 Tu: `quiero una cita para cotizar`

> 🤖 IA: *"Con gusto. ¿Para qué fecha le viene bien?"*

> 🧑 Tu: `el miercoles en la tarde`

> 🤖 IA: *"El miércoles [fecha] en la tarde. ¿A qué hora exactamente?"*

> 🧑 Tu: `a las 2`

> 🤖 IA: *"El miércoles a las 2:00 PM, 1 hora. ¿Le parece bien?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"Cotización para Mabel Mendoza el [miércoles] a las 2:00 PM. ¿Está correcto?"*

> 🧑 Tu: `sí`

> 🤖 IA: *"¡Su cita quedó registrada! Que tenga un buen día, Mabel."*

**Verificacion:**
- ✅ `toNumber = +15550000002` (compania 163, Sophie Blinds LLC)
- ✅ `customerId` corresponde a Mabel Mendoza en compania 163
- ✅ `step = completed` — cita creada

---

### Resumen de cobertura

| Guion | Nivel | Escenario | Cliente | Telefono |
|---|---|---|---|---|
| 1 | Nivel 1 | Caller ID match unico, espanol | Maria Elena Rodriguez | `305-545-2936` |
| 2 | Nivel 1 | Caller ID match unico, ingles | Brian Williams | `786-853-4538` |
| 3 | Nivel 2 | Telefono falso → buscar por nombre → 1 resultado | Maria Elena Rodriguez | `999-999-9999` |
| 4 | Nivel 2 | Telefono falso → nombre comun → desambiguacion | Jorge Lopez | `999-888-7777` |
| 5 | Nivel 3 | 3 fallos → LLM → registro cliente nuevo | (nuevo) | `999-111-2222` |
| 6 | Nivel 2 | Sin Caller ID → pide nombre directo | Mabel Mendoza | (vacio) |
| 7 | Nivel 1 | Multi-tenant — compania 163 | Paulino Hernandez | `786-236-0929` |
| 8 | Completo | Cita completa espanol — todos los pasos | Diosdado Fernandez | `305-362-1270` |
| 9 | Completo | Cita completa ingles — fecha+hora juntas | Althea Mcmillan | `305-904-2387` |
| 10 | Completo | Cancelar en confirmacion y reiniciar | Sonia Iglesias | `954-438-4043` |
| 11 | Completo | Area code fuera FL (404 Atlanta) | Russ Nordahl | `404-384-2663` |
| 12 | TTS | Apellido dificil — calidad de voz | Blake Lickteig | `305-522-1365` |
| 13 | Busqueda | Cliente en 2 companias — compania correcta | Mabel Mendoza | `305-323-2397` |

*Ultima actualizacion: Febrero 2026*
