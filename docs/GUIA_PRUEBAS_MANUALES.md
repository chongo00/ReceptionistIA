# Guia de Pruebas Manuales — Receptionist IA (BlindsBook)

> **Fecha:** Febrero 2026 — Version 3.0
> **Objetivo:** Probar el sistema de IA Recepcionista paso a paso, incluyendo el flujo hibrido de identificacion de cliente (3 niveles) y prueba de voz en tiempo real por microfono.

---

## Tabla de Contenidos

1. [Resumen del Sistema](#1-resumen-del-sistema)
2. [Requisitos Previos](#2-requisitos-previos)
3. [Paso 1 — Levantar los Servicios](#3-paso-1--levantar-los-servicios)
4. [Paso 2 — Verificar que Todo Funciona](#4-paso-2--verificar-que-todo-funciona)
5. [Paso 3 — Prueba de Voz en Tiempo Real](#5-paso-3--prueba-de-voz-en-tiempo-real-microfono)
6. [Escenarios de Prueba: Identificacion de Cliente](#6-escenarios-de-prueba-identificacion-de-cliente)
7. [Escenarios de Prueba: Flujo Completo de Cita](#7-escenarios-de-prueba-flujo-completo-de-cita)
8. [Prueba por Texto (PowerShell / cURL)](#8-prueba-por-texto-powershell--curl)
9. [Verificar Cita en el Sistema](#9-verificar-cita-en-el-sistema)
10. [Sistema Multi-Tenant (Companias)](#10-sistema-multi-tenant-companias)
11. [Endpoints Disponibles](#11-endpoints-disponibles)
12. [Solucion de Problemas](#12-solucion-de-problemas)
13. [Arquitectura Tecnica](#13-arquitectura-tecnica)
14. [Matriz de Verificacion Rapida](#14-matriz-de-verificacion-rapida)

---

## Comandos Docker — Setup Completo

> Ejecutar desde: `D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA`

```bash
# ── PASO 1: Construir y levantar todos los contenedores ──
# (La primera vez construira la imagen de Ollama con el modelo pre-cargado, tarda ~5-10 min)
docker compose up -d --build

# ── PASO 2: Verificar que los contenedores estan corriendo ──
docker compose ps
# Deben aparecer: blindsbook-ia y ollama

# ── PASO 3: Health checks ──
curl http://localhost:4000/health
# -> {"ok":true,"service":"blindsbook-ia","status":"healthy","ollama":"connected"}

curl http://localhost:11434/api/tags
# -> Debe listar qwen2.5:3b (ya viene pre-cargado en la imagen)

# ── PASO 4: Test rapido del modelo LLM ──
curl http://localhost:11434/api/generate -d "{\"model\":\"qwen2.5:3b\",\"prompt\":\"Hola, como estas?\",\"stream\":false}"
# Debe responder en espanol en 2-5 segundos

# ── PASO 5: Abrir pruebas en navegador ──
# http://localhost:4000/test/voice-test.html
```

### Comandos de mantenimiento

```bash
# Ver logs de todos los servicios
docker compose logs -f

# Ver logs solo de Ollama
docker compose logs -f ollama

# Rebuild solo la IA (despues de cambios en codigo)
docker compose up -d --build blindsbook-ia

# Cambiar a un modelo mas ligero (si RAM es limitada)
docker compose exec ollama ollama pull qwen2.5:1.5b
# Luego cambiar OLLAMA_MODEL=qwen2.5:1.5b en .env y reiniciar:
docker compose up -d --build blindsbook-ia

# Detener todo (los datos del modelo se mantienen en el volumen)
docker compose down

# Detener todo Y borrar volumenes (ELIMINA el modelo descargado)
docker compose down -v
```

### Fases pendientes (futuras, post-pruebas)

- **FASE 6**: Pruebas end-to-end con los 14 escenarios documentados en la guia
- **FASE 7**: Limpieza para produccion (metricas, logs estructurados)

## Diagrama del Flujo Hibrido de Identificacion

```
LLAMADA ENTRANTE
      |
      v
  [askLanguage]  "Para espanol presione 1. For English press 2."
      |
      v
  [identifyByCallerId]  ---- Nivel 1: Buscar por Caller ID (From) automatico
      |
      +-- 1 match ---------> "Hola [nombre]!" ----> [greeting] -> flujo cita
      |
      +-- 2-5 matches -----> [disambiguateCustomer] "Encontre varias cuentas..."
      |                            |
      |                            +-- elige opcion --> [confirmCustomerIdentity] -> [greeting]
      |
      +-- 0 matches --------> [askCustomerName] ---- Nivel 2: Pedir nombre/telefono
                                    |
                                    +-- 1 match -> [confirmCustomerIdentity] -> [greeting]
                                    +-- N matches -> [disambiguateCustomer]
                                    +-- 0 matches (x3) -> [llmFallback] -- Nivel 3: Mini LLM
                                                              |
                                                              +-- identificado -> [greeting]
                                                              +-- cliente nuevo -> [greeting]
                                                              +-- no resuelto -> transferir
```

---

## 1. Resumen del Sistema

La **IA Recepcionista** es un asistente de voz que identifica clientes y agenda citas para BlindsBook.

**Flujo principal:**
```
Cliente habla -> Microfono del navegador (STT) -> Texto -> IA procesa el dialogo
      |                                                        |
  Escucha respuesta  <-  Audio MP3 <- Piper TTS (Docker)  <- Texto de respuesta
```

**Componentes:**

| Servicio | Puerto | Funcion |
|----------|--------|---------|
| **Receptionist IA** (Node/Express) | 4000 | Servidor principal: dialogo, identificacion, endpoints de prueba, pagina de voz |
| **BlindsBook-IA** (Docker/Python) | 8000 | Sintesis de voz (Piper TTS) — convierte texto a audio MP3 |
| **App-BlindsBook API** (NestJS) | 3000 | Base de datos de clientes, citas, equipo (obligatorio para identificacion) |
| **Ollama** (Docker/nativo) | 11434 | Mini LLM local (Qwen2.5-3B) para Nivel 3 de identificacion |

**Que se puede probar:**
- Hablar por microfono y que la IA responda con voz (requiere puertos 4000 + 8000)
- Identificacion automatica por Caller ID (requiere puerto 3000)
- Identificacion por nombre/telefono con confirmacion (requiere puerto 3000)
- Identificacion inteligente por LLM con busqueda por vendedor (requiere puertos 3000 + 11434)
- Flujo completo: identificacion -> tipo -> fecha -> hora -> confirmacion -> cita creada

---

## 2. Requisitos Previos

### Software necesario

- **Node.js** >= 18 (para Receptionist IA)
- **Docker Desktop** (para BlindsBook-IA con Piper TTS y Ollama)
- **Navegador Chrome o Edge** (para prueba de voz — necesita Web Speech API)
- **Microfono** activo en tu computadora

### Archivos de configuracion

El archivo `.env` en la raiz de `Receptionist IA/` debe tener configurado:

```env
# API
BLINDSBOOK_API_BASE_URL=http://localhost:3000
BLINDSBOOK_LOGIN_EMAIL=tu_email@blindsbook.com
BLINDSBOOK_LOGIN_PASSWORD=tu_password

# TTS Docker
DOCKER_TTS_URL=http://localhost:8000

# Ollama (Mini LLM)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b

# Multi-tenant
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550000001":{"token":"JWT_TOKEN","companyId":387}}
```

Ver `.env.example` para referencia completa.

---

## 3. Paso 1 — Levantar los Servicios

Abre **4 terminales** de PowerShell:

### Terminal 1: Docker IA (TTS)

```powershell
# Verificar que el contenedor ya esta corriendo
docker ps | Select-String "blindsbook-ia"

# Si NO esta corriendo, iniciarlo:
docker start blindsbook-ia

# Verificar:
Invoke-RestMethod -Uri "http://localhost:8000/health"
```

### Terminal 2: Ollama (Mini LLM)

```powershell
# Opcion A: Ollama nativo (si esta instalado)
ollama serve

# Opcion B: Ollama en Docker
docker compose up ollama

# Verificar que el modelo esta descargado:
ollama list
# Debe listar "qwen2.5:3b"

# Si no esta descargado:
ollama pull qwen2.5:3b
```

### Terminal 3: Receptionist IA

```powershell
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
npm run dev
# Esperar: "Servicio IA recepcionista escuchando en puerto 4000"
```

### Terminal 4: API BlindsBook

```powershell
cd "D:\Disco E trabajos\repositorio_blindsbook\App-BlindsBook\api"
npm run start:dev
# Esperar: "Nest application successfully started"
```

> **NOTA:** La API BlindsBook (puerto 3000) es **obligatoria** para identificacion de clientes. Sin ella, Niveles 1-3 no funcionan.

---

## 4. Paso 2 — Verificar que Todo Funciona

```powershell
# 1. Health check Receptionist IA (incluye status de Ollama)
Invoke-RestMethod -Uri "http://localhost:4000/health"
# Respuesta: { ok: true, service: "receptionist-ai", status: "healthy", ollama: "connected" }

# 2. Health check Docker TTS
Invoke-RestMethod -Uri "http://localhost:8000/health"

# 3. Health check Ollama
Invoke-RestMethod -Uri "http://localhost:11434/api/tags"
# Debe listar modelos instalados, incluyendo "qwen2.5:3b"

# 4. Health check API BlindsBook
Invoke-RestMethod -Uri "http://localhost:3000/api/health"

# 5. Probar TTS (genera un audio de prueba)
Invoke-WebRequest -Uri "http://localhost:4000/debug/play-audio?text=Hola%20bienvenido&lang=es" -UseBasicParsing -OutFile "test_audio.mp3"
Start-Process "test_audio.mp3"
```

Si los 4 servicios responden, estas listo para probar.

---

## 5. Paso 3 — Prueba de Voz en Tiempo Real (Microfono)

### Abrir la Pagina de Pruebas de Voz

1. Abre **Chrome** o **Edge**
2. Navega a: **http://localhost:4000/test/voice-test.html**
3. **Permite el acceso al microfono** cuando el navegador lo solicite

### Campos de la interfaz

| Campo | Descripcion | Valor por defecto |
|---|---|---|
| **To Number** | Numero Twilio que recibe la llamada (determina la compania) | Selector de compania |
| **Caller ID** | Numero del que llama (simula el `From` de Twilio) | `+15551234567` |
| **Texto / Microfono** | Lo que dice el usuario (texto o voz via Web Speech API) | - |

### Barra de estado inferior

Muestra en tiempo real:
- `step`: Paso actual del dialogo (identifyByCallerId, askCustomerName, greeting, askType, etc.)
- `callerPhone`: Numero del llamante
- `customerConfirmedName`: Nombre confirmado del cliente
- `customerId`: ID del cliente identificado
- `identificationAttempts`: Intentos de identificacion realizados

### Funcionamiento del boton

- **Click en microfono** -> el microfono se activa, aparece "Escuchando..."
- **Habla** -> el navegador convierte tu voz a texto (Web Speech API)
- **Automaticamente** -> el texto se envia a la IA, la respuesta se reproduce como audio
- **Mientras la IA habla** -> el boton muestra "IA hablando..." y el microfono esta desactivado
- **Cuando termina** -> puedes volver a presionar el microfono

### Nueva conversacion

Haz click en **Nueva conversacion** para reiniciar el flujo desde cero.

---

## 6. Escenarios de Prueba: Identificacion de Cliente

### Datos de prueba recomendados

Antes de probar, asegurate de tener en la base de datos de App-BlindsBook:

- **1 cliente con telefono unico**: Para probar Nivel 1 (match unico por Caller ID)
- **2+ clientes con el mismo telefono**: Para probar desambiguacion
- **1 cliente sin telefono registrado**: Para probar Nivel 2 (busqueda por nombre)
- **1 vendedor/asesor registrado**: Para probar Nivel 3 (busqueda por vendedor)

---

### Escenario 1: Nivel 1 — Cliente existente, match unico por telefono

**Preparacion**: Poner en "Caller ID" el telefono registrado de un cliente existente.

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 1 | Poner en Caller ID el telefono del cliente | `+1XXXXXXXXXX` | - |
| 2 | Iniciar conversacion | - | "Para espanol presione 1. For English press 2." |
| 3 | Seleccionar idioma | `1` | "Hola [Nombre]! Bienvenido de vuelta a BlindsBook. En que puedo ayudarle hoy?" |
| 4 | Verificar estado | - | `step=greeting`, `customerId` con valor, `customerConfirmedName` con nombre |

**Resultado**: Identificacion automatica sin preguntar nada. Directo a greeting.

---

### Escenario 2: Nivel 1 — Telefono con multiples clientes (desambiguacion)

**Preparacion**: Poner en "Caller ID" un telefono compartido por 2-5 clientes.

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 1 | Seleccionar idioma | `1` | "Encontre varias cuentas con ese numero: 1. Juan Perez (tel. ***1234) 2. Maria Lopez (tel. ***5678). Podria decirme su nombre?" |
| 2a | Responder con numero | `1` | "Perfecto, Juan Perez. En que puedo ayudarle hoy?" |
| 2b | O responder con nombre | `Maria` | "Encontre a Maria Lopez. Es usted?" |
| 3 | Confirmar (si 2b) | `si` | "Perfecto, Maria Lopez. En que puedo ayudarle hoy?" |

---

### Escenario 3: Nivel 1 — Telefono no registrado (pasa a Nivel 2)

**Preparacion**: Poner en "Caller ID" un numero que NO esta en la BD (ej: `+19999999999`).

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 1 | Seleccionar idioma | `1` | "Bienvenido a BlindsBook. No reconozco este numero. Me podria dar su nombre completo o el telefono con el que se registro?" |
| 2 | Verificar estado | - | `step=askCustomerName` (Nivel 2) |

---

### Escenario 4: Nivel 2 — Cliente encontrado por nombre (1 match)

**Continuacion del Escenario 3.**

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 3 | Dar nombre del cliente | `Juan Perez` | "Encontre a Juan Alberto Perez Rodriguez. Es usted?" |
| 4 | Confirmar | `si` | "Perfecto, Juan Alberto Perez Rodriguez. En que puedo ayudarle hoy?" |
| 5 | Verificar estado | - | `step=greeting`, `customerId` con valor |

---

### Escenario 5: Nivel 2 — Multiples clientes con mismo nombre

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 3 | Dar nombre parcial | `Juan` | "Encontre varios clientes: 1. Juan Perez (tel. ***1234) 2. Juan Martinez (tel. ***5678). Cual es usted?" |
| 4 | Elegir | `2` | "Perfecto, Juan Martinez. En que puedo ayudarle hoy?" |

---

### Escenario 6: Nivel 2 — 3 intentos fallidos -> Nivel 3 LLM

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 3 | Nombre incorrecto #1 | `ZZZZZ` | "No encontre a ZZZZZ. Podria intentar con otro nombre, telefono o email?" |
| 4 | Nombre incorrecto #2 | `YYYYY` | "No encontre a YYYYY..." |
| 5 | Nombre incorrecto #3 | `XXXXX` | (Pasa a Nivel 3 LLM) "No pude encontrarlo. Recuerda el nombre de su vendedor o asesor?" |
| 6 | Verificar estado | - | `step=llmFallback` |

---

### Escenario 7: Nivel 3 — Identificacion por vendedor

> **Requiere**: Ollama corriendo con modelo `qwen2.5:3b` descargado.

**Continuacion del Escenario 6.**

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 7 | Dar nombre del vendedor | `Me atendio Carlos` | LLM busca vendedores, encuentra "Carlos Rodriguez". Luego lista sus clientes. |
| 8 | Identificarse | `Soy Maria` | "Lo encontre, Maria Lopez!" -> `step=greeting` |

---

### Escenario 8: Nivel 3 — Cliente nuevo (registro)

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 7 | Indicar que es nuevo | `Es primera vez que llamo` | LLM: "Le gustaria que lo registre como cliente nuevo? Necesitaria su nombre completo." |
| 8 | Dar nombre | `Roberto Gonzalez` | LLM crea el cliente: "Lo he registrado como cliente nuevo." -> `step=greeting` |

---

### Escenario 9: Nivel 3 — Ollama no disponible (fallback)

**Preparacion**: Detener Ollama antes de llegar al Nivel 3.

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 7 | (Ollama apagado) | - | "Estoy teniendo dificultades tecnicas. Le gustaria que lo registre como cliente nuevo?" |

**Resultado**: El sistema no se cae. Ofrece alternativa amable.

---

### Escenario 10: Sin Caller ID (voice-test sin numero)

**Preparacion**: Dejar el campo "Caller ID" vacio.

| # | Accion | Input | Respuesta esperada |
|---|---|---|---|
| 1 | Seleccionar idioma | `1` | "Bienvenido a BlindsBook. Me podria dar su nombre completo o el numero de telefono con el que se registro?" |

**Resultado**: Sin caller phone, va directo a Nivel 2.

---

## 7. Escenarios de Prueba: Flujo Completo de Cita

### Escenario 11: Flujo completo desde identificacion hasta cita creada

| # | Paso | Input | Respuesta IA | Step |
|---|---|---|---|---|
| 1 | Idioma | `1` | (Identificacion automatica) "Hola [Nombre]!" | greeting |
| 2 | (greeting) | `quiero una cita` | "La visita es para cotizacion, instalacion o reparacion?" | askType |
| 3 | Tipo | `cotizacion` | "Perfecto, [Nombre], agendaremos cotizacion. Para que fecha?" | askDate |
| 4 | Fecha | `manana` | "Bien, anotare para el [fecha]. A que hora?" | askTime |
| 5 | Hora | `a las 10 de la manana` | "La cita sera el [fecha] 10:00. Duracion estandar una hora. Esta bien?" | askDuration |
| 6 | Duracion | `si` | Resumen completo: Tipo, Cliente, Fecha, Duracion. "Correcto?" | confirmSummary |
| 7 | Confirmar | `si` | "Estoy creando su cita..." -> "Su cita ha sido registrada exitosamente." | completed |

**Verificacion**: Revisar en la BD de App-BlindsBook que la cita se creo con el `customerId` correcto.

### Escenario 12: Fecha con hora incluida (salta askTime)

Si el usuario dice fecha Y hora juntas:

| Input | Resultado |
|---|---|
| "manana a las 3 de la tarde" | Salta askTime, va directo a askDuration |
| "next Monday at 10 AM" | Salta askTime, va directo a askDuration |

### Escenario 13: Cancelar y empezar de nuevo

En el paso de confirmacion, si dice "no":

| # | Input | Respuesta | Step |
|---|---|---|---|
| 7 | `no` | "De acuerdo, empecemos de nuevo. Cotizacion, instalacion o reparacion?" | askType |

### Escenario 14: Instalacion en ingles

| # | Input | Respuesta | Step |
|---|---|---|---|
| 1 | `2` / `English` | (Identificacion en ingles) "Hello [Name]!" | greeting |
| 2 | `installation` | "We'll schedule an installation. What date?" | askDate |
| ... | ... | (todo en ingles) | ... |

---

## 8. Prueba por Texto (PowerShell / cURL)

### POST /debug/chat (solo texto, sin audio)

```powershell
# Iniciar conversacion con Caller ID
$callId = "test-$(Get-Date -Format 'HHmmss')"

# Primer turno (saludo)
$body = @{callId=$callId; text=$null; toNumber='+15550000001'; fromNumber='+15551234567'} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/debug/chat" -Method POST -ContentType "application/json" -Body $body | Select replyText | Format-List

# Seleccionar idioma
$body = @{callId=$callId; text='1'} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/debug/chat" -Method POST -ContentType "application/json" -Body $body | Select replyText | Format-List

# Continuar segun la respuesta...
```

### POST /debug/voice-chat (con audio TTS)

```powershell
$body = @{callId='voice-001'; text=$null; fromNumber='+15551234567'} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/debug/voice-chat" -Method POST -ContentType "application/json" -Body $body | Select replyText, ttsProvider, audioUrl | Format-List
# Respuesta incluye: audioBase64, audioUrl, ttsProvider
```

### cURL equivalente (Linux/Mac/Git Bash)

```bash
# Iniciar con Caller ID
curl -X POST http://localhost:4000/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-001","text":null,"fromNumber":"+15551234567","toNumber":"+15550000001"}'

# Seleccionar idioma
curl -X POST http://localhost:4000/debug/chat \
  -H "Content-Type: application/json" \
  -d '{"callId":"test-001","text":"1"}'
```

### Funcion helper para dialogo completo (PowerShell)

```powershell
$base = "http://localhost:4000"
$id = "test-ps-$(Get-Date -Format 'HHmmss')"

function Chat($text, $fromNumber=$null) {
    $payload = @{callId=$id; text=$text}
    if ($fromNumber) { $payload.fromNumber = $fromNumber }
    $payload.toNumber = '+15550000001'
    $b = $payload | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$base/debug/voice-chat" -Method POST -Body $b -ContentType "application/json"
    Write-Host ""
    Write-Host "  TU: $text" -ForegroundColor Yellow
    Write-Host "  IA: $($r.replyText)" -ForegroundColor Green
    Write-Host "  [Step: $($r.state.step) | Customer: $($r.state.customerConfirmedName) | TTS: $($r.ttsProvider)]" -ForegroundColor DarkGray
    return $r
}

# Flujo con identificacion automatica
Chat $null '+15551234567'    # Saludo + Caller ID
Chat "1"                      # Espanol -> identifica por telefono (o pide nombre)
Chat "cotizacion"             # Tipo de cita
Chat "manana a las 3"         # Fecha + hora
Chat "esta bien"              # Duracion OK
Chat "si"                     # Confirmar
```

---

## 9. Verificar Cita en el Sistema

### Via API (PowerShell)

```powershell
$token = "TU_JWT_DEL_ENV"
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "http://localhost:3000/api/appointments?page=1&pageSize=5" -Headers $headers | ConvertTo-Json -Depth 6
```

### Via SQL Server

```sql
USE db_blindTest;
SELECT TOP 5
    a.Id, a.CustomerId, a.Type, a.Status,
    e.Start, e.Duration,
    c.FirstName + ' ' + c.LastName AS CustomerName
FROM [Schedule].[Appointments] a
JOIN [Schedule].[Events] e ON e.Id = a.Id
LEFT JOIN [Customer].[Customers] c ON c.Id = a.CustomerId
ORDER BY a.Id DESC;
```

---

## 10. Sistema Multi-Tenant (Companias)

### Como funciona

El sistema identifica a que compania pertenece la cita usando el parametro `toNumber`, que simula el numero Twilio al que el cliente llamo.

Cada numero esta configurado en `.env` con su propio token JWT y companyId:

| Numero (toNumber) | CompanyId | Email | Descripcion |
|---|---|---|---|
| `+15550000001` | 387 | karla1@blindsbook.com | Compania principal de pruebas |
| `+15550000002` | 2 | adortax76@hotmail.com | Compania secundaria |

### En la pagina de voz

La pagina web tiene un **selector de compania** en la parte superior. Al elegir una, se envia el `toNumber` correspondiente. El **Caller ID** se envia como `fromNumber` para la identificacion automatica.

### Agregar mas companias

Edita el `.env`:
```
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550000001":{"companyId":387,"token":"JWT"},"+15550000002":{"companyId":2,"token":"JWT"}}
```

---

## 11. Endpoints Disponibles

| Metodo | Ruta | Descripcion |
|---|---|---|
| `GET` | `/health` | Health check (incluye status de Ollama) |
| `GET` | `/test/voice-test.html` | Pagina de prueba de voz con microfono |
| `POST` | `/debug/voice-chat` | Dialogo + audio TTS (JSON con audioBase64) |
| `POST` | `/debug/chat` | Solo dialogo sin audio (mas rapido) |
| `GET` | `/debug/play-audio?text=X&lang=es` | TTS directo — devuelve MP3 |
| `GET` | `/tts/:id.mp3` | Audio TTS en cache (temporal, 10 min) |
| `POST` | `/twilio/voice-webhook` | Webhook para Twilio (produccion) |

### Detalle de /debug/voice-chat y /debug/chat

**Request:**
```json
{
  "callId": "string",
  "text": "string | null",
  "toNumber": "string (opcional — determina compania)",
  "fromNumber": "string (opcional — simula Caller ID)"
}
```

**Response:**
```json
{
  "replyText": "Hola Juan! Bienvenido de vuelta...",
  "state": {
    "callId": "string",
    "language": "es",
    "step": "greeting",
    "callerPhone": "+15551234567",
    "customerId": 42,
    "customerConfirmedName": "Juan Perez",
    "identificationAttempts": 0,
    "type": null,
    "startDateISO": null,
    "duration": "01:00:00",
    "status": 0
  },
  "isFinished": false,
  "ttsProvider": "docker",
  "audioUrl": "/tts/abc123.mp3",
  "audioBase64": "//uQxAAA..."
}
```

---

## 12. Solucion de Problemas

### "No se puede conectar al servidor" (puerto 4000)

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/health"
# Si no responde:
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"
npm run dev
```

### "EADDRINUSE: address already in use :::4000"

```powershell
Get-NetTCPConnection -LocalPort 4000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### "ttsProvider: none" (sin audio)

```powershell
docker ps | Select-String "blindsbook-ia"
# Si no aparece:
docker start blindsbook-ia
Invoke-RestMethod -Uri "http://localhost:8000/health"
```

### Health check muestra `"ollama": "unavailable"`

```powershell
# Verificar que Ollama esta corriendo:
curl http://localhost:11434/api/tags

# Si no responde:
ollama serve           # nativo
# o
docker compose up ollama  # Docker

# Verificar modelo descargado:
ollama list
# Si no aparece qwen2.5:3b:
ollama pull qwen2.5:3b
```

### "No pude encontrar a [nombre]" siempre

La API BlindsBook (puerto 3000) no esta corriendo, o el JWT expiro:

```powershell
# Verificar API:
Invoke-RestMethod -Uri "http://localhost:3000/api/health"

# Renovar JWT:
$loginBody = @{email="karla1@blindsbook.com"; password="TU_PASSWORD"} | ConvertTo-Json
$response = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/login" -Method POST -Body $loginBody -ContentType "application/json"
$response.data.token
# Copia el nuevo token al .env en TWILIO_NUMBER_TO_COMPANY_MAP
```

### El LLM responde en idioma incorrecto

El system prompt incluye el idioma seleccionado por el usuario. Verificar que `state.language` se pasa correctamente al Nivel 3. Esto depende de que el usuario haya seleccionado idioma en el primer paso.

### Error "Failed to create customer: no id returned"

Verificar que `POST /api/customers` de App-BlindsBook funciona:
```powershell
$token = "TU_JWT"
$body = @{firstName="Test"; lastName="User"; phone="+10000000000"} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/customers" -Method POST -Body $body -ContentType "application/json" -Headers @{Authorization="Bearer $token"}
```

### "Tu navegador no soporta Web Speech API"

- Usar **Google Chrome** o **Microsoft Edge** (versiones actuales)
- Firefox y Safari NO soportan Web Speech API para STT
- Acceder por `http://localhost` (no por IP)

### "Permiso de microfono denegado"

1. Click en el icono del candado junto a la URL en Chrome
2. Buscar "Microfono" y cambiarlo a "Permitir"
3. Recargar la pagina

### Fechas que la IA entiende

La IA usa chrono-node para parsear fechas naturales:

| Lo que dices | Como lo interpreta |
|---|---|
| "manana" | Dia siguiente |
| "el lunes" / "next Monday" | Proximo lunes |
| "20 de febrero" | 20 de febrero del anio actual |
| "manana a las 3 de la tarde" | Dia siguiente, 15:00 |
| "a las 10" / "10 AM" | Hora (se combina con la fecha ya elegida) |

---

## 13. Arquitectura Tecnica

### Diagrama de Componentes

```
+--------------------------------------------------------------------+
|                      PRUEBA DE VOZ                                  |
|                                                                     |
|  Chrome/Edge (http://localhost:4000/test/voice-test.html)          |
|                                                                     |
|  [Microfono] -> Web Speech API (STT gratis) -> Texto               |
|                                                      |              |
|  [Parlante] <- Audio MP3 <- POST /debug/voice-chat -> JSON resp    |
+--------------------------------------------------------------------+
         |                                       |
         v                                       v
+------------------+   +------------------+   +------------------+
| Receptionist IA  |   | BlindsBook-IA    |   | App-BlindsBook   |
| Express + TS     |-->| Docker + Python  |   | NestJS API       |
| Puerto: 4000     |   | Puerto: 8000     |   | Puerto: 3000     |
|                  |   |                  |   |                  |
| Dialogo citas    |   | Piper TTS (ES)   |   | Clientes         |
| Identificacion   |   | Piper TTS (EN)   |   | Citas            |
| 3-level cascade  |   |                  |   | Team members     |
| Multi-tenant     |   |                  |   | JWT Auth         |
+------------------+   +------------------+   +------------------+
         |
         v
+------------------+
| Ollama           |
| Puerto: 11434    |
|                  |
| Qwen2.5-3B      |
| Function calling |
| $0 / llamada     |
+------------------+
```

### Flujo del Dialogo (State Machine)

```
askLanguage
    |
    v
identifyByCallerId (Nivel 1: Caller ID automatico)
    |
    +-> disambiguateCustomer (multiples matches)
    +-> askCustomerName (Nivel 2: pedir nombre/telefono)
    +-> confirmCustomerIdentity ("Es usted X?")
    +-> llmFallback (Nivel 3: Mini LLM)
    |
    v
greeting (saludo personalizado)
    |
    v
askType -> askDate -> [askTime] -> askDuration -> confirmSummary -> creatingAppointment -> completed
                                                       |
                                                       +-- (si "no") --> askType
```

### Tecnologias

| Componente | Tecnologia | Costo |
|---|---|---|
| **STT (Speech-to-Text)** | Web Speech API del navegador | $0 |
| **TTS (Text-to-Speech)** | Piper en Docker (voces neurales) | $0 |
| **Parseo de fechas** | chrono-node (NLP ligero) | $0 |
| **Identificacion Nivel 3** | Ollama + Qwen2.5-3B (LLM local) | $0 |
| **Dialogo** | State machine en TypeScript | $0 |

---

## 14. Matriz de Verificacion Rapida

| # | Que verificar | Como | OK? |
|---|---|---|---|
| 1 | `/health` responde con status de Ollama | `curl localhost:4000/health` | [ ] |
| 2 | Caller ID con match unico -> saludo por nombre | voice-test con telefono registrado | [ ] |
| 3 | Caller ID con multiples matches -> lista opciones | voice-test con telefono compartido | [ ] |
| 4 | Caller ID sin match -> pide nombre | voice-test con telefono nuevo | [ ] |
| 5 | Sin Caller ID -> pide nombre directo | voice-test con campo Caller ID vacio | [ ] |
| 6 | Busqueda por nombre -> encuentra y confirma | Escribir nombre de cliente existente | [ ] |
| 7 | 3 intentos fallidos -> entra a Nivel 3 LLM | Escribir nombres inexistentes 3 veces | [ ] |
| 8 | LLM busca por vendedor -> encuentra cliente | Dar nombre de vendedor en Nivel 3 | [ ] |
| 9 | LLM registra cliente nuevo | Decir "es primera vez" en Nivel 3 | [ ] |
| 10 | Ollama apagado -> fallback amable | Detener Ollama, llegar a Nivel 3 | [ ] |
| 11 | Flujo completo: identificacion -> cita creada en BD | Completar todos los pasos | [ ] |
| 12 | Audio TTS funciona en voice-test.html | Verificar que se escucha el audio | [ ] |
| 13 | Seleccion de idioma ingles funciona | Presionar 2 y verificar respuestas en ingles | [ ] |
| 14 | Multi-tenant: cambiar compania y verificar datos | Cambiar selector de compania | [ ] |

---

*Ultima actualizacion: Febrero 2026 — Version 3.0 (Flujo hibrido de identificacion de cliente)*
