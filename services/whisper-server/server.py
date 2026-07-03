"""
Jarvis AI — Faster-Whisper Transcription Server

A lightweight FastAPI server that wraps the faster-whisper library.
The Whisper model is loaded once at startup and kept in memory.

Endpoints:
    GET  /health      → Server status and model info
    POST /transcribe  → Accepts raw WAV binary, returns transcription JSON

Usage:
    python server.py [port]
    python server.py          # defaults to port 8100
    python server.py 8200     # custom port
"""

import os
import sys
import tempfile
import time

# Ensure stdout and stderr use UTF-8 encoding on Windows to avoid 'charmap' encoding issues
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "1"))
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", None)
# Convert empty string to None to ensure it runs auto-detect correctly
if WHISPER_LANGUAGE == "":
    WHISPER_LANGUAGE = None
WHISPER_INITIAL_PROMPT = os.environ.get(
    "WHISPER_INITIAL_PROMPT",
    "English and Telugu speech written using English letters. Example: na peru koushik, nuvvu ela unnavu."
)
if WHISPER_INITIAL_PROMPT == "":
    WHISPER_INITIAL_PROMPT = None

# ──────────────────────────────────────────────
# FastAPI app
# ──────────────────────────────────────────────

app = FastAPI(title="Jarvis Whisper Server")

# Global model reference — loaded once at startup
model = None


@app.on_event("startup")
async def load_model():
    """Load the Whisper model into memory at server startup."""
    global model
    from faster_whisper import WhisperModel

    print(f"[Whisper] Loading model '{WHISPER_MODEL}' "
          f"(device={WHISPER_DEVICE}, compute_type={WHISPER_COMPUTE_TYPE})...")
    start = time.time()

    model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)

    elapsed = time.time() - start
    print(f"[Whisper] Model loaded and ready. ({elapsed:.1f}s)")


@app.get("/health")
async def health():
    """Health check endpoint. Returns model status."""
    if model is None:
        return JSONResponse(
            {"status": "loading", "model": WHISPER_MODEL},
            status_code=503,
        )
    return {"status": "ready", "model": WHISPER_MODEL}




@app.post("/transcribe")
async def transcribe(request: Request, language: str = None, initial_prompt: str = None):
    """
    Transcribe audio to text.

    Accepts raw WAV binary in the request body (Content-Type: audio/wav).
    Returns JSON: { "text": "...", "language": "en", "language_probability": 0.99 }
    """
    if model is None:
        return JSONResponse(
            {"error": "Model is still loading. Please try again shortly."},
            status_code=503,
        )

    # Read the raw audio bytes from the request body
    audio_bytes = await request.body()
    if not audio_bytes:
        return JSONResponse(
            {"error": "No audio data received. Send a WAV file in the request body."},
            status_code=400,
        )

    audio_size_kb = len(audio_bytes) / 1024
    print(f"[Whisper] Received {audio_size_kb:.1f} KB of audio data")

    # Save to a temp file — faster-whisper requires a file path
    fd, temp_path = tempfile.mkstemp(suffix=".wav")
    try:
        os.write(fd, audio_bytes)
        os.close(fd)

        # Determine target language and prompt (prioritize query parameters, fallback to environment defaults)
        target_lang = language if language is not None else WHISPER_LANGUAGE
        target_prompt = initial_prompt if initial_prompt is not None else WHISPER_INITIAL_PROMPT

        start = time.time()

        # Transcribe using single-pass with target_lang (None or set) and target_prompt
        segments_gen, info = model.transcribe(
            temp_path,
            beam_size=BEAM_SIZE,
            language=target_lang,
            initial_prompt=target_prompt
        )
        segments = list(segments_gen)
        texts = [seg.text.strip() for seg in segments]
        text = " ".join(texts).strip()
        selected_lang = info.language
        selected_prob = info.language_probability

        elapsed = time.time() - start

        # Log result in the specified [STT] format
        print(f"\n[STT]")
        print(f"Language: {selected_lang}")
        print(f"Confidence: {selected_prob:.2f}")
        print(f"Transcript: {text}\n")

        return {
            "text": text,
            "language": selected_lang,
            "language_probability": round(selected_prob, 4),
            "duration_seconds": round(elapsed, 3),
        }

    except Exception as e:
        print(f"[Whisper] Transcription error: {e}")
        return JSONResponse(
            {"error": f"Transcription failed: {str(e)}"},
            status_code=500,
        )
    finally:
        # Always clean up the temp file
        if os.path.exists(temp_path):
            os.unlink(temp_path)


# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
    print(f"[Whisper] Starting server on http://127.0.0.1:{port}")
    print(f"[Whisper] Model: {WHISPER_MODEL} | Device: {WHISPER_DEVICE} | Compute: {WHISPER_COMPUTE_TYPE}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
