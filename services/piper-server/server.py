"""
Jarvis AI — Piper TTS Synthesis Server

A lightweight FastAPI server that wraps the piper-tts library.
The Piper voice model is loaded once at startup and kept in memory.

Endpoints:
    GET  /health      → Server status and model info
    POST /synthesize  → Accepts JSON { "text": "..." }, returns WAV audio bytes

Usage:
    python server.py [port]
    python server.py          # defaults to port 8200
    python server.py 8300     # custom port

Model Setup:
    Place the .onnx and .onnx.json files in the models/ directory next to this script.
    Or set the PIPER_MODEL_PATH environment variable to the full path of the .onnx file.

    Example:
        services/piper-server/models/en_US-lessac-medium.onnx
        services/piper-server/models/en_US-lessac-medium.onnx.json
"""

import os
import sys
import io
import wave
import time
import glob

# Ensure stdout and stderr use UTF-8 encoding on Windows to avoid 'charmap' encoding issues
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        import io as _io
        sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
        sys.stderr = _io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(SCRIPT_DIR, "models")

# Allow overriding the full model path via environment variable
PIPER_MODEL_PATH = os.environ.get("PIPER_MODEL_PATH", None)

# ──────────────────────────────────────────────
# FastAPI app
# ──────────────────────────────────────────────

app = FastAPI(title="Jarvis Piper TTS Server")

# Global model reference — loaded once at startup
voice = None
model_name = None
model_sample_rate = None
model_load_error = None


def _find_default_model():
    """
    Search the models/ directory for the first .onnx file.
    Returns the full path to the .onnx file, or None if no models are found.
    """
    if not os.path.isdir(MODELS_DIR):
        return None
    onnx_files = glob.glob(os.path.join(MODELS_DIR, "*.onnx"))
    if not onnx_files:
        return None
    # Return the first .onnx file found (sorted for determinism)
    return sorted(onnx_files)[0]


@app.on_event("startup")
async def load_model():
    """Load the Piper voice model into memory at server startup."""
    global voice, model_name, model_sample_rate, model_load_error

    # Determine model path
    model_path = PIPER_MODEL_PATH or _find_default_model()

    if model_path is None:
        model_load_error = (
            f"No Piper voice model found.\n"
            f"Please download a voice model and place the .onnx and .onnx.json files in:\n"
            f"  {MODELS_DIR}\n\n"
            f"Download models from: https://huggingface.co/rhasspy/piper-voices/tree/main\n"
            f"Recommended: en_US-lessac-medium.onnx\n\n"
            f"Or set the PIPER_MODEL_PATH environment variable to the full path of the .onnx file."
        )
        print(f"[Piper] ✗ {model_load_error}")
        return

    if not os.path.exists(model_path):
        model_load_error = (
            f"Model file not found: {model_path}\n"
            f"Please download the model and place it at the path above.\n"
            f"Download from: https://huggingface.co/rhasspy/piper-voices/tree/main"
        )
        print(f"[Piper] ✗ {model_load_error}")
        return

    # Check for the .onnx.json config file
    config_path = model_path + ".json"
    if not os.path.exists(config_path):
        model_load_error = (
            f"Model config file not found: {config_path}\n"
            f"Each Piper model requires both the .onnx file and the .onnx.json config file.\n"
            f"Please download both files from: https://huggingface.co/rhasspy/piper-voices/tree/main"
        )
        print(f"[Piper] ✗ {model_load_error}")
        return

    try:
        from piper.voice import PiperVoice

        model_name = os.path.splitext(os.path.basename(model_path))[0]
        print(f"[Piper] Loading voice model '{model_name}'...")
        start = time.time()

        voice = PiperVoice.load(model_path, config_path)
        model_sample_rate = voice.config.sample_rate

        elapsed = time.time() - start
        print(f"[Piper] ✓ Voice model loaded and ready. ({elapsed:.1f}s)")
        print(f"[Piper]   Sample rate: {model_sample_rate} Hz")

    except ImportError:
        model_load_error = (
            "The 'piper-tts' Python package is not installed.\n"
            "Install it with: pip install piper-tts"
        )
        print(f"[Piper] ✗ {model_load_error}")

    except Exception as e:
        model_load_error = f"Failed to load Piper model: {str(e)}"
        print(f"[Piper] ✗ {model_load_error}")


@app.get("/health")
async def health():
    """Health check endpoint. Returns model status."""
    if model_load_error is not None:
        return JSONResponse(
            {
                "status": "error",
                "error": model_load_error,
            },
            status_code=503,
        )

    if voice is None:
        return JSONResponse(
            {"status": "loading", "model": model_name},
            status_code=503,
        )

    return {
        "status": "ready",
        "model": model_name,
        "sample_rate": model_sample_rate,
    }


class SynthesizeRequest(BaseModel):
    text: str


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    """
    Synthesize text to speech.

    Accepts JSON: { "text": "Hello world" }
    Returns: WAV audio bytes (Content-Type: audio/wav)
    """
    if voice is None:
        error_msg = model_load_error or "Voice model is still loading. Please try again shortly."
        return JSONResponse(
            {"error": error_msg},
            status_code=503,
        )

    text = request.text.strip()
    if not text:
        return JSONResponse(
            {"error": "No text provided. Send JSON with a 'text' field."},
            status_code=400,
        )

    print(f"[Piper] Synthesizing: \"{text[:80]}{'...' if len(text) > 80 else ''}\"")

    try:
        start = time.time()

        # Synthesize into an in-memory WAV buffer
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wav_file:
            voice.synthesize_wav(text, wav_file)

        elapsed = time.time() - start
        wav_buf.seek(0)
        wav_data = wav_buf.read()
        audio_size_kb = len(wav_data) / 1024

        print(f"[Piper] ✓ Synthesis complete: {audio_size_kb:.1f} KB ({elapsed:.2f}s)")

        return Response(
            content=wav_data,
            media_type="audio/wav",
        )

    except Exception as e:
        print(f"[Piper] ✗ Synthesis error: {e}")
        return JSONResponse(
            {"error": f"Synthesis failed: {str(e)}"},
            status_code=500,
        )


# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8200
    print(f"[Piper] Starting server on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
