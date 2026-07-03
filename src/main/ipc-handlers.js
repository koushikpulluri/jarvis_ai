'use strict';

const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Registers all IPC handlers that bridge the renderer process to backend services.
 *
 * @param {import('./state-manager').StateManager} stateManager
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} services - Backend service instances.
 * @param {import('./services/stt-service').SttService} [services.sttService] - STT service.
 * @param {import('./services/ollama-service').OllamaService} [services.ollamaService] - Ollama service.
 * @param {import('./services/tts-service').TtsService} [services.ttsService] - TTS service.
 */
function registerIpcHandlers(stateManager, mainWindow, services = {}) {
  const { sttService, ollamaService, ttsService } = services;

  // Session-only conversation history (cleared on app close)
  const conversationHistory = [
    {
      role: 'system',
      content:
        'You are Jarvis, a helpful, polite, and intelligent local AI assistant. ' +
        'Keep your responses concise, clear, and direct. ' +
        'Do not use markdown formatting (like bold, bullet points, or headers) in your responses. ' +
        'Crucial: Keep your responses under 3 sentences unless the user explicitly asks for detail.',
    },
  ];
  // Watchdog timer to prevent the application from getting stuck in the THINKING state
  let thinkingWatchdog = null;

  const resetThinkingWatchdog = () => {
    if (thinkingWatchdog) {
      clearTimeout(thinkingWatchdog);
    }
    thinkingWatchdog = setTimeout(() => {
      // Guard: only fire if still in THINKING state to prevent double-ERROR race
      if (stateManager.currentState !== 'THINKING') {
        thinkingWatchdog = null;
        return;
      }
      console.warn('[Watchdog] Application stuck in THINKING state for 40 seconds. Auto-recovering...');
      thinkingWatchdog = null;
      stateManager.transitionTo('ERROR', { message: 'Watchdog timeout: The system is taking too long to respond.' });
    }, 40000);
  };

  const clearThinkingWatchdog = () => {
    if (thinkingWatchdog) {
      clearTimeout(thinkingWatchdog);
      thinkingWatchdog = null;
    }
  };

  // Clear watchdog on any state transition away from THINKING
  stateManager.on('state-changed', (newState) => {
    if (newState !== 'THINKING') {
      clearThinkingWatchdog();
    }
  });

  // ──────────────────────────────────────────────
  // Audio playback tracking for TTS
  // ──────────────────────────────────────────────

  /** Resolve function for the current playback-end promise (null if not speaking). */
  let playbackEndResolve = null;

  /** Watchdog timer to recover from stuck SPEAKING state. */
  let speakingWatchdog = null;
  const SPEAKING_WATCHDOG_MS = 60000; // 60s max for any TTS playback

  const startSpeakingWatchdog = () => {
    if (speakingWatchdog) clearTimeout(speakingWatchdog);
    speakingWatchdog = setTimeout(() => {
      if (stateManager.currentState !== 'SPEAKING') {
        speakingWatchdog = null;
        return;
      }
      console.warn('[Watchdog] Application stuck in SPEAKING state for 60 seconds. Auto-recovering...');
      speakingWatchdog = null;
      // Resolve any pending playback promise
      if (playbackEndResolve) {
        playbackEndResolve({ reason: 'watchdog' });
        playbackEndResolve = null;
      }
      stateManager.transitionTo('IDLE');
    }, SPEAKING_WATCHDOG_MS);
  };

  const clearSpeakingWatchdog = () => {
    if (speakingWatchdog) {
      clearTimeout(speakingWatchdog);
      speakingWatchdog = null;
    }
  };

  stateManager.on('state-changed', (newState) => {
    if (newState !== 'SPEAKING') {
      clearSpeakingWatchdog();
    }
  });

  // ──────────────────────────────────────────────
  // State queries
  // ──────────────────────────────────────────────

  /** Returns the current application state. */
  ipcMain.handle('get-state', () => {
    return stateManager.currentState;
  });

  // ──────────────────────────────────────────────
  // Listening controls
  // ──────────────────────────────────────────────

  /**
   * Start listening for voice input.
   * Transitions state from IDLE → LISTENING.
   */
  ipcMain.handle('start-listening', () => {
    console.log('[IPC] Handler start-listening invoked');
    const success = stateManager.transitionTo('LISTENING');
    if (!success) {
      console.warn('[IPC] Transition to LISTENING rejected');
      return { ok: false, error: 'Cannot start listening in current state' };
    }
    return { ok: true };
  });

  /**
   * Stop listening and process the captured audio.
   * Receives the WAV audio buffer from the renderer.
   *
   * Pipeline: WAV → Faster-Whisper (STT) → Display transcription.
   * Future phases will extend this to: → Ollama (LLM) → Piper (TTS).
   *
   * @param {ArrayBuffer|null} audioData - The recorded WAV audio data.
   */
  ipcMain.handle('stop-listening', async (_event, audioData, recordingMeta) => {
    console.log('[IPC] Handler stop-listening invoked');
    // If no audio was captured, return to IDLE
    if (!audioData || audioData.byteLength === 0) {
      console.log('[IPC] No audio received. Returning to IDLE');
      stateManager.transitionTo('IDLE');
      return { ok: true, cancelled: true };
    }

    // Transition to THINKING
    const success = stateManager.transitionTo('THINKING');
    if (!success) {
      console.warn('[IPC] Transition to THINKING rejected');
      return { ok: false, error: 'Cannot process audio in current state' };
    }

    // Start watchdog timer
    resetThinkingWatchdog();

    try {
      const pipelineStart = Date.now();
      const audioBuffer = Buffer.from(audioData);
      const audioSizeKB = (audioBuffer.length / 1024).toFixed(1);
      // Use actual recording duration from renderer, or estimate from byte size
      const recordingDuration = (recordingMeta && recordingMeta.durationSec)
        ? recordingMeta.durationSec
        : parseFloat(((audioBuffer.length - 44) / 32000).toFixed(1));
      console.log(`[IPC] Processing WAV: ${audioSizeKB} KB (${recordingDuration}s)`);

      // ── Step 1: Transcribe via Faster-Whisper ──
      if (!sttService) {
        throw new Error('STT service not configured.');
      }

      console.log('[IPC] Sending audio to Faster-Whisper...');
      const sttStart = Date.now();
      const result = await sttService.transcribe(audioBuffer);
      const sttTime = ((Date.now() - sttStart) / 1000).toFixed(1);
      const transcription = result.text;
      console.log(`[Pipeline] Whisper STT: ${sttTime}s`);

      // Handle empty transcription (silence or noise)
      if (!transcription || transcription.trim().length === 0) {
        console.log('[IPC] Empty transcription — no speech detected');
        sendToRenderer(mainWindow, 'assistant-message', {
          text: 'I didn\'t catch that. Please try speaking again.',
          timestamp: Date.now(),
        });
        clearThinkingWatchdog();
        console.log('[IPC] Transitioning state back to IDLE');
        stateManager.transitionTo('IDLE');
        return { ok: true, empty: true };
      }

      // Show the user's transcribed speech
      console.log('[IPC] Sending user-message to renderer');
      sendToRenderer(mainWindow, 'user-message', {
        text: transcription,
        timestamp: Date.now(),
      });

      // ── Step 2: Send query to Ollama (LLM) ──
      if (!ollamaService) {
        throw new Error('Ollama service not configured.');
      }

      // Add user transcription to conversation history
      conversationHistory.push({ role: 'user', content: transcription });

      let fullResponse = '';
      console.log('[IPC] Sending messages to Ollama...');
      const llmStart = Date.now();

      // Chat with streaming tokens
      await ollamaService.chat(conversationHistory, (token) => {
        // Reset/feed watchdog timer on every received token
        resetThinkingWatchdog();
        fullResponse += token;
        sendToRenderer(mainWindow, 'assistant-token', token);
      });

      const llmTime = ((Date.now() - llmStart) / 1000).toFixed(1);
      console.log(`[Pipeline] Ollama LLM: ${llmTime}s (${fullResponse.length} chars)`);

      // Add assistant response to conversation history
      conversationHistory.push({ role: 'assistant', content: fullResponse });

      // Send the final complete message to the renderer
      console.log('[IPC] Sending assistant-message to renderer');
      sendToRenderer(mainWindow, 'assistant-message', {
        text: fullResponse,
        timestamp: Date.now(),
      });

      clearThinkingWatchdog();

      // ── Step 3: Text-to-Speech via Piper (graceful fallback) ──
      let ttsTime = null;
      if (ttsService) {
        try {
          const ttsAvailable = await ttsService.isAvailable();
          if (ttsAvailable) {
            console.log('[IPC] Sending text to Piper TTS...');
            const ttsStart = Date.now();
            const wavBuffer = await ttsService.synthesize(fullResponse);
            ttsTime = ((Date.now() - ttsStart) / 1000).toFixed(1);
            console.log(`[Pipeline] Piper TTS: ${ttsTime}s (${(wavBuffer.length / 1024).toFixed(1)} KB)`);

            // Transition to SPEAKING and send audio to renderer
            stateManager.transitionTo('SPEAKING');
            sendToRenderer(mainWindow, 'play-audio', wavBuffer.buffer.slice(
              wavBuffer.byteOffset,
              wavBuffer.byteOffset + wavBuffer.byteLength
            ));

            // Wait for playback to finish (or be skipped)
            startSpeakingWatchdog();
            await new Promise((resolve) => {
              playbackEndResolve = resolve;
            });
            playbackEndResolve = null;
            clearSpeakingWatchdog();
            console.log('[IPC] Audio playback completed');
          } else {
            console.log('[IPC] Piper TTS not available — skipping audio, text-only response');
          }
        } catch (ttsErr) {
          console.error('[IPC] TTS Error (non-fatal, falling back to text-only):', ttsErr.message);
          ttsTime = 'error';
          // If we got stuck in SPEAKING state, recover
          if (stateManager.currentState === 'SPEAKING') {
            // Transition back to a safe state before going IDLE
            // SPEAKING → IDLE is a valid transition
          }
        }
      }

      const totalTime = ((Date.now() - pipelineStart) / 1000).toFixed(1);
      console.log(
        `\n[Pipeline] Recording: ${recordingDuration}s | STT: ${sttTime}s | LLM: ${llmTime}s` +
        (ttsTime && ttsTime !== 'error' ? ` | TTS: ${ttsTime}s` : (ttsTime === 'error' ? ' | TTS: error' : ' | TTS: skipped')) +
        ` | Total: ${totalTime}s\n`
      );

      // Send pipeline metrics to renderer for display
      sendToRenderer(mainWindow, 'pipeline-metrics', {
        recordingTime: recordingDuration,
        sttTime: parseFloat(sttTime),
        llmTime: parseFloat(llmTime),
        ttsTime: ttsTime && ttsTime !== 'error' ? parseFloat(ttsTime) : null,
        ttsSkipped: !ttsTime || ttsTime === 'error',
        totalTime: parseFloat(totalTime),
      });

      console.log('[IPC] Transitioning state back to IDLE');
      stateManager.transitionTo('IDLE');
      return { ok: true };
    } catch (err) {
      clearThinkingWatchdog();
      console.error('[IPC] Exception caught during pipeline execution:', err.message);

      // Save debug WAV when transcription fails
      const debugWavPath = saveDebugWav(audioData);

      sendToRenderer(mainWindow, 'assistant-message', {
        text: `Error: ${err.message}` + (debugWavPath ? `\n\nDebug recording saved: ${debugWavPath}` : ''),
        timestamp: Date.now(),
      });

      stateManager.transitionTo('ERROR', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  // ──────────────────────────────────────────────
  // State change forwarding
  // ──────────────────────────────────────────────

  stateManager.on('state-changed', (newState, previousState, metadata) => {
    sendToRenderer(mainWindow, 'state-changed', {
      state: newState,
      previousState,
      metadata,
    });
  });

  // ──────────────────────────────────────────────
  // Audio playback controls (TTS)
  // ──────────────────────────────────────────────

  /**
   * Handle audio playback ended notification from renderer.
   * Called when TTS audio finishes playing, is skipped, or errors.
   */
  ipcMain.handle('audio-playback-ended', (_event, data) => {
    console.log(`[IPC] Audio playback ended: ${data ? data.reason : 'unknown'}`);
    if (playbackEndResolve) {
      playbackEndResolve(data);
      playbackEndResolve = null;
    }
    // If we're still in SPEAKING state and playback ended, go to IDLE
    if (stateManager.currentState === 'SPEAKING') {
      clearSpeakingWatchdog();
      stateManager.transitionTo('IDLE');
    }
    return { ok: true };
  });

  /**
   * Handle skip speech request from renderer.
   * User clicked the "Skip" button during TTS playback.
   */
  ipcMain.handle('skip-speech', () => {
    console.log('[IPC] Skip speech requested');
    // The renderer will stop audio playback and send audio-playback-ended
    // But we also resolve the promise here in case of race conditions
    if (playbackEndResolve) {
      playbackEndResolve({ reason: 'skipped' });
      playbackEndResolve = null;
    }
    if (stateManager.currentState === 'SPEAKING') {
      clearSpeakingWatchdog();
      stateManager.transitionTo('IDLE');
    }
    return { ok: true };
  });

  // ──────────────────────────────────────────────
  // App info
  // ──────────────────────────────────────────────

  ipcMain.handle('get-app-info', async () => {
    let llmStatus = 'not configured';
    if (ollamaService) {
      const status = await ollamaService.checkStatus();
      if (!status.running) {
        llmStatus = 'not running';
      } else if (!status.modelAvailable) {
        llmStatus = 'model missing';
      } else {
        llmStatus = 'connected';
      }
    }

    let ttsStatus = 'not configured';
    if (ttsService) {
      try {
        const status = await ttsService.checkStatus();
        if (!status.running) {
          ttsStatus = 'not running';
        } else if (!status.ready) {
          ttsStatus = status.error || 'model not loaded';
        } else {
          ttsStatus = 'connected';
        }
      } catch {
        ttsStatus = 'error';
      }
    }

    return {
      name: 'Jarvis AI',
      version: '1.1.0',
      phase: 6,
      services: {
        stt: sttService ? 'configured' : 'not configured',
        llm: llmStatus,
        tts: ttsStatus,
      },
    };
  });
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Safely send a message to the renderer process.
 * @param {Electron.BrowserWindow} window
 * @param {string} channel
 * @param {*} data
 */
function sendToRenderer(window, channel, data) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, data);
  }
}

/**
 * Save WAV audio to a temp file for debugging.
 * @param {ArrayBuffer} audioData
 * @returns {string|null} Path to the saved file, or null on failure.
 */
function saveDebugWav(audioData) {
  try {
    const tempDir = app.getPath('temp');
    const debugPath = path.join(tempDir, 'jarvis_debug_recording.wav');
    fs.writeFileSync(debugPath, Buffer.from(audioData));
    console.log(`[IPC] Debug WAV saved: ${debugPath}`);
    return debugPath;
  } catch (err) {
    console.error('[IPC] Failed to save debug WAV:', err.message);
    return null;
  }
}

/**
 * Removes all registered IPC handlers.
 * Called during app shutdown.
 */
function removeIpcHandlers() {
  ipcMain.removeHandler('get-state');
  ipcMain.removeHandler('start-listening');
  ipcMain.removeHandler('stop-listening');
  ipcMain.removeHandler('audio-playback-ended');
  ipcMain.removeHandler('skip-speech');
  ipcMain.removeHandler('get-app-info');
}

module.exports = { registerIpcHandlers, removeIpcHandlers };
