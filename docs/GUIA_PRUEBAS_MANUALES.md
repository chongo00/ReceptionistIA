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

## Comandos Docker — Setup Completo (Contenedor Unico)

> **Arquitectura:** Un solo contenedor Docker con Node.js + Ollama + modelo qwen2.5:3b integrado.
> **Ejecutar desde:** `D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA`
> **NOTA:** La primera vez puede tardar 30-90 min si el internet es lento (descarga Node.js, Ollama y modelo ~2GB).

```bash
# ── PASO 1: Construir la imagen unificada (Node.js + Ollama + modelo) ──
# Timeout largo: puede tardar 30-90 min por descarga del modelo qwen2.5:3b (~2GB)
# Use --progress=plain para ver el progreso detallado del build
DOCKER_BUILDKIT=1 docker build --progress=plain --no-cache -f Dockerfile.unified -t blindsbook-ia-unified .

# ── PASO 2: Levantar el contenedor unico ──
docker compose up -d

# ── PASO 3: Ver logs en tiempo real (esperar a que Ollama y Node.js inicien) ──
docker compose logs -f blindsbook-ia
# Esperar los mensajes:
#   [1/3] Iniciando Ollama...
#   [2/3] Esperando que Ollama responda...
#        ✓ Ollama listo
#   [3/3] Iniciando Receptionist IA en puerto 4000...

# ── PASO 4: Health checks (en otra terminal, PowerShell) ──
# NOTA: En PowerShell "curl" es un alias de Invoke-WebRequest. Usar curl.exe o Invoke-RestMethod.
Invoke-RestMethod http://localhost:4000/health
# -> ok: true, service: blindsbook-ia, status: healthy, ollama: connected

Invoke-RestMethod http://localhost:11434/api/tags
# -> Debe listar qwen2.5:3b (viene pre-cargado en la imagen)

# ── PASO 5: Test rapido del modelo LLM ──
Invoke-RestMethod -Uri http://localhost:11434/api/generate -Method POST -Body '{"model":"qwen2.5:3b","prompt":"Hola","stream":false}' -ContentType 'application/json'
# Debe responder en espanol en 2-10 segundos

# ── PASO 6: Abrir pruebas en navegador ──
# http://localhost:4000/test/voice-test.html
```

### Comandos de mantenimiento

```bash
# Ver logs del contenedor
docker compose logs -f

# Rebuild despues de cambios en codigo (rapido, el modelo ya esta en la imagen)
docker compose up -d --build

# Cambiar a un modelo mas ligero (si RAM es limitada)
docker compose exec blindsbook-ia ollama pull qwen2.5:1.5b
# Luego cambiar OLLAMA_MODEL=qwen2.5:1.5b en .env y reiniciar:
docker compose up -d

# Entrar al contenedor para debug
docker compose exec blindsbook-ia bash

# Detener todo (los datos del modelo se mantienen en el volumen)
docker compose down

# Detener todo Y borrar volumenes (ELIMINA el modelo descargado del volumen)
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
| **Receptionist IA + Ollama** (Contenedor Unico) | 4000 + 11434 | Servidor Node.js + Ollama + Qwen2.5-3B en un solo contenedor Docker |
| **BlindsBook-IA** (Docker/Python) | 8000 | Sintesis de voz (Piper TTS) — convierte texto a audio MP3 (opcional) |
| **App-BlindsBook API** (NestJS) | 3000 | Base de datos de clientes, citas, equipo (obligatorio para identificacion) |

**Que se puede probar:**
- Hablar por microfono y que la IA responda con voz (requiere puertos 4000 + 8000)
- Identificacion automatica por Caller ID (requiere puerto 3000)
- Identificacion por nombre/telefono con confirmacion (requiere puerto 3000)
- Identificacion inteligente por LLM con busqueda por vendedor (requiere puertos 3000 + 4000)
- Flujo completo: identificacion -> tipo -> fecha -> hora -> confirmacion -> cita creada

---

## 2. Requisitos Previos

### Software necesario

- **Docker Desktop** (unico requisito — el contenedor incluye Node.js + Ollama + modelo LLM)
- **Navegador Chrome o Edge** (para prueba de voz — necesita Web Speech API)
- **Microfono** activo en tu computadora

### Archivos de configuracion

El archivo `.env` en la raiz de `Receptionist IA/` debe tener configurado:

```env
# API (URL del server de pruebas Azure)
BLINDSBOOK_API_BASE_URL=https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io

# Superusuario para auto-login + switch-company (RECOMENDADO):
# Un solo usuario con IsSuperUser=1 puede generar tokens para CUALQUIER compania.
# El sistema hace login y luego POST /api/auth/switch-company para cada compania.
BLINDSBOOK_LOGIN_EMAIL=carconval@gmail.com
BLINDSBOOK_LOGIN_PASSWORD=charlie

# Token estatico (OPCIONAL): solo si NO usas auto-login.
BLINDSBOOK_API_TOKEN=

# TTS Docker
DOCKER_TTS_URL=http://localhost:8000

# Ollama (Mini LLM)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b

# Multi-tenant: cada numero Twilio apunta a un companyId.
# El superusuario (arriba) usa switch-company para generar JWT por compania.
# Solo necesitas poner el companyId, NO email/password por compania.
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550000001":{"companyId":2},"+15550000002":{"companyId":163}}
```

> **IMPORTANTE — Tokens y Auto-login con switch-company:**
> La API BlindsBook usa JWT que expiran en 24h. Como Receptionist IA es un sistema
> automatizado (nadie se loguea manualmente), implementa **auto-renovacion**:
>
> 1. **Al iniciar**: login como superusuario → obtiene JWT base
> 2. **Switch-company**: para cada compania en el mapa, llama `POST /api/auth/switch-company`
>    → obtiene JWT especifico con el companyId correcto
> 3. **Cada 30 min**: verifica si algun token esta por expirar (< 1h de vida)
> 4. **Si expira**: renueva el token base y luego switch-company otra vez
> 5. **Si recibe 401**: invalida el token, re-obtiene via switch-company y reintenta
>
> **No necesitas renovar tokens manualmente.** Solo asegurate de que las credenciales
> del superusuario en `.env` sean validas.

---

## 3. Paso 1 — Levantar los Servicios

Abre **2 terminales** de PowerShell:

### Terminal 1: Receptionist IA + Ollama (Contenedor Unico)

```powershell
cd "D:\Disco E trabajos\repositorio_blindsbook\Receptionist IA"

# Primera vez: construir imagen (30-90 min con internet lento)
docker compose up -d --build

# Ver logs para confirmar que todo inicio bien:
docker compose logs -f blindsbook-ia
# Esperar:
#   [1/3] Iniciando Ollama...
#   [2/3] Esperando que Ollama responda...
#        ✓ Ollama listo
#   [3/3] Iniciando Receptionist IA en puerto 4000...
```

### Terminal 2: API BlindsBook

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
# Obtener token (login manual para verificar)
$body = @{email="tu_email@co.com"; password="tu_password"} | ConvertTo-Json
$login = Invoke-RestMethod -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/auth/login" -Method POST -Body $body -ContentType "application/json"
$token = $login.data.token

$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/appointments?page=1&pageSize=5" -Headers $headers | ConvertTo-Json -Depth 6
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

Un **superusuario** (`carconval@gmail.com` / password: `charlie`) hace login una vez y luego usa `POST /api/auth/switch-company` para obtener JWT especificos por compania. **No se necesitan credenciales individuales** por compania.

| Numero (toNumber) | CompanyId | Compania | Clientes |
|---|---|---|---|
| `+15550000001` | 2 | All Blinds Inc | ~6,400 |
| `+15550000002` | 163 | Sophie Blinds LLC | ~6,400 |

### En la pagina de voz

La pagina web tiene un **selector de compania** en la parte superior. Al elegir una, se envia el `toNumber` correspondiente. El **Caller ID** se envia como `fromNumber` para la identificacion automatica.

### Agregar mas companias

Edita el `.env`. **Con switch-company (recomendado — solo necesitas companyId):**
```
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550000001":{"companyId":2},"+15550000002":{"companyId":163},"+15550000003":{"companyId":387}}
```

El superusuario (`BLINDSBOOK_LOGIN_EMAIL` / `BLINDSBOOK_LOGIN_PASSWORD`) genera tokens para todas las companias automaticamente.

**Formato legacy con credenciales propias por compania:**
```
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550000001":{"companyId":163,"email":"user@co.com","password":"pass"}}
```

**Formato legacy con token estatico (expira en 24h — NO recomendado):**
```
TWILIO_NUMBER_TO_COMPANY_MAP={"+15550000001":{"companyId":163,"token":"JWT_aqui"}}
```

> Se pueden mezclar los 3 formatos. El sistema prioriza: switch-company > credenciales propias > token estatico.

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

# Si no responde, reiniciar el contenedor:
docker compose restart blindsbook-ia
docker compose logs -f blindsbook-ia
# Esperar que aparezca "✓ Ollama listo"

# Verificar modelo desde dentro del contenedor:
docker compose exec blindsbook-ia ollama list
# Si no aparece qwen2.5:3b:
docker compose exec blindsbook-ia ollama pull qwen2.5:3b
```

### "No pude encontrar a [nombre]" siempre

La API BlindsBook no esta accesible, o las credenciales en `.env` son incorrectas:

```powershell
# Verificar API:
Invoke-RestMethod -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/health"

# Verificar logs del TokenManager:
docker compose logs --tail 30 blindsbook-ia | Select-String "TokenManager"
# Debe mostrar: "[TokenManager] ✓ Login compañía 163 OK"
# Si muestra: "[TokenManager] ✗ Login ... falló" → las credenciales son incorrectas

# Probar login manualmente:
$body = @{email="tu_email@co.com"; password="tu_password"} | ConvertTo-Json
Invoke-RestMethod -Uri "https://blindsbook-mobile-api-test.ambitiouswave-0fcb242f.eastus.azurecontainerapps.io/api/auth/login" -Method POST -Body $body -ContentType "application/json"
```

> **NOTA:** Los tokens se renuevan automaticamente. Si el login falla, verifica que
> BLINDSBOOK_LOGIN_EMAIL y BLINDSBOOK_LOGIN_PASSWORD en el .env sean correctos.

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
+-------------------------------+             +------------------+
| Receptionist IA (Cont. Unico)|             | App-BlindsBook   |
| Docker: Ubuntu 22.04         |             | NestJS API       |
| Puerto: 4000 + 11434         |             | Puerto: 3000     |
|                               |             |                  |
| ┌──────────────────────────┐ |             | Clientes         |
| │ Node.js (Express + TS)   │ |             | Citas            |
| │ Dialogo, Identificacion  │ |             | Team members     |
| │ Multi-tenant, 3-level    │ |             | JWT Auth         |
| └──────────────────────────┘ |             +------------------+
| ┌──────────────────────────┐ |
| │ Ollama + Qwen2.5-3B     │ |
| │ Function calling         │ |
| │ $0 / llamada             │ |
| └──────────────────────────┘ |
+-------------------------------+
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
| 15 | Customer lookup por telefono muestra tarjeta | Buscar numero en voice-test.html | [ ] |
| 16 | Auto-configuracion de toNumber y callerPhone | Buscar cliente y verificar campos auto-rellenados | [ ] |

---

## 15. Numeros de Telefono de Prueba

### 15.1 Companias Configuradas (TWILIO_NUMBER_TO_COMPANY_MAP)

Las siguientes companias estan configuradas en el sistema y pueden ser probadas end-to-end:

| Twilio Number | Company ID | Nombre Compania |
|---|---|---|
| `+15550000001` | 2 | All Blinds Inc |
| `+15550000002` | 163 | Sophie Blinds LLC |
| `+15550000003` | 387 | (karla1@blindsbook.com — sin clientes con telefono) |

### 15.2 Clientes de Compania 2 — All Blinds Inc (toNumber: +15550000001)

| # | ID | Nombre | Apellido | Telefono | Notas |
|---|---|---|---|---|---|
| 1 | 1330 | Maria Elena | Rodriguez | `305-545-2936` | Nombre hispano completo |
| 2 | 8122 | ADOLFO | ALVAREZ | `786-236-1132` | Nombre hispano |
| 3 | 218 | Iris | Matos | `305-812-2468` | Nombre corto |
| 4 | 11789 | Althea | Mcmillan | `305-904-2387` | Nombre anglosajon |
| 5 | 13508 | Diosdado | Fernandez | `305-362-1270` | Nombre poco comun |
| 6 | 11262 | Brian | Williams | `786-853-4538` | Nombre anglosajon |
| 7 | 17259 | ONAY | TORRES | `305-582-6498` | Nombre hispano |
| 8 | 14534 | Mark | Hambacher | `786-442-4989` | Nombre con apellido complejo |
| 9 | 11469 | SONIA | IGLESIAS | `954-438-4043` | Area code 954 (Broward) |
| 10 | 7777 | Bernadin | Goindoo | `305-336-2201` | Nombre internacional |
| 11 | 4530 | JORGE | LOPEZ | `786-239-4584` | Nombre muy comun (posible multi-match) |
| 12 | 7036 | MARIA | IBARRA | `305-726-4672` | Nombre muy comun |

### 15.3 Clientes de Compania 163 — Sophie Blinds LLC (toNumber: +15550000002)

| # | ID | Nombre | Apellido | Telefono | Notas |
|---|---|---|---|---|---|
| 1 | 20646 | Mabel | Mendoza | `305-323-2397` | Nombre hispano |
| 2 | 19519 | Debie | Lima | `305-792-1773` | Nombre corto |
| 3 | 18608 | PAULINO | HERNANDEZ | `786-236-0929` | Nombre hispano |
| 4 | 22121 | Jorge | Tubella | `305-970-7356` | Apellido poco comun |
| 5 | 19071 | BETTY | LOPEZ | `786-718-7027` | Nombre comun |
| 6 | 21312 | NAUSSEN | JEFFERY | `954-684-6077` | Area code 954 |
| 7 | 29368 | Cris | Broward | `954-614-5572` | Area code 954 |
| 8 | 23484 | Russ | Nordahl | `404-384-2663` | Area code 404 (Atlanta, fuera de FL) |
| 9 | 19810 | Yaris | Vale | `954-775-0118` | Nombre unico |
| 10 | 23875 | BLAKE | LICKTEIG | `305-522-1365` | Apellido dificil de pronunciar |
| 11 | 19177 | Natasha | Ragoonana | `305-613-2662` | Nombre con apellido complejo |
| 12 | 23299 | JOSE | GONZALEZ | `305-219-0502` | Nombre muy comun (test multi-match) |

### 15.4 Como Usar los Numeros de Prueba

#### Flujo con Busqueda de Cliente (voice-test.html)

1. Abrir `http://localhost:4000/test/voice-test.html`
2. En el campo **"Busqueda de Cliente por Telefono"** escribir un numero de la tabla (ej: `305-545-2936`)
3. Presionar **Buscar** — el sistema consulta `/debug/customer-lookup` en las 3 companias configuradas
4. Se muestra la **tarjeta del cliente** con:
   - ID, Nombre completo, Compania, Telefono, Account Manager
   - **toNumber** y **Caller ID** se configuran automaticamente
5. Presionar **Nueva conversacion** para iniciar el flujo de voz/texto
6. La IA debe identificar al cliente por el Caller ID y saludarlo por nombre

#### Flujo Manual (sin busqueda)

1. Seleccionar la compania en el dropdown
2. Escribir el telefono del cliente en **Caller ID** (ej: `305-545-2936`)
3. Presionar **Nueva conversacion**
4. La IA identifica al cliente y continua el flujo

### 15.5 Escenarios de Prueba por Tipo

| Escenario | Telefono Sugerido | Compania | Que Verificar |
|---|---|---|---|
| Match unico hispano | `305-545-2936` (Maria Elena Rodriguez) | 2 | Identifica y saluda en espanol |
| Match unico anglosajon | `786-853-4538` (Brian Williams) | 2 | Identifica y ofrece ingles |
| Nombre muy comun (multi-match) | `786-239-4584` (Jorge Lopez) | 2 | Si hay multiples Jorge, pide desambiguar |
| Area code diferente (954) | `954-438-4043` (Sonia Iglesias) | 2 | Funciona con area code Broward |
| Area code fuera de FL | `404-384-2663` (Russ Nordahl) | 163 | Funciona con area code Atlanta |
| Apellido dificil | `305-522-1365` (Blake Lickteig) | 163 | La IA pronuncia correctamente |
| Telefono no registrado | `999-999-9999` | — | Pide nombre al no encontrar |
| Sin Caller ID | (dejar vacio) | 2 | Pide nombre directamente |
| Compania diferente | `305-323-2397` (Mabel Mendoza) | 163 | Verifica que busca en compania 163 |
| Flujo completo cita | `305-362-1270` (Diosdado Fernandez) | 2 | Identificacion → tipo → fecha → crear cita |

### 15.6 Endpoint de Busqueda (API Debug)

**GET** `/debug/customer-lookup?phone={numero}`

Busca el numero de telefono en todas las companias del `TWILIO_NUMBER_TO_COMPANY_MAP`.

**Ejemplo:**
```
GET http://localhost:4000/debug/customer-lookup?phone=305-545-2936
```

**Respuesta:**
```json
{
  "success": true,
  "phone": "305-545-2936",
  "companiesSearched": [2, 163, 387],
  "totalResults": 1,
  "results": [
    {
      "id": 1330,
      "firstName": "Maria Elena",
      "lastName": "Rodriguez",
      "companyName": null,
      "phone": "305-545-2936",
      "accountManagerId": null,
      "companyId": 2,
      "twilioNumber": "+15550000001"
    }
  ]
}
```

---

*Ultima actualizacion: Julio 2025 — Version 4.0 (Busqueda de cliente por telefono + datos en tiempo real)*
