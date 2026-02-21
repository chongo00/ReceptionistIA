#!/bin/bash
# ─────────────────────────────────────────────────────────
# entrypoint.sh — Inicia Ollama y luego la app Node.js
# ─────────────────────────────────────────────────────────

set -e

echo "╔═══════════════════════════════════════════════╗"
echo "║  BlindsBook Receptionist IA (Contenedor Único)║"
echo "╚═══════════════════════════════════════════════╝"

# 1. Iniciar Ollama en background (escuchar en todas las interfaces para acceso externo)
echo "[1/3] Iniciando Ollama..."
OLLAMA_HOST=0.0.0.0:11434 ollama serve &
OLLAMA_PID=$!

# 2. Esperar a que Ollama esté listo (hasta 5 min)
echo "[2/3] Esperando que Ollama responda..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "  ✓ Ollama listo (intento $i)"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "  ⚠ Ollama no respondió después de 5 min, continuando de todas formas..."
  fi
  sleep 5
done

# Verificar que el modelo está disponible
echo "  Modelos disponibles:"
curl -sf http://localhost:11434/api/tags | grep -o '"name":"[^"]*"' || echo "  (no se pudieron listar)"

# 3. Iniciar la app Node.js
echo "[3/3] Iniciando Receptionist IA en puerto ${PORT:-4000}..."
exec node /app/dist/index.js
