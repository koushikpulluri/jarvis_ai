'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { StateManager } = require('./state-manager');
const { SttService } = require('./services/stt-service');
const { OllamaService } = require('./services/ollama-service');
const { TtsService } = require('./services/tts-service');
const { WhisperLauncher } = require('./services/whisper-launcher');
const { PiperLauncher } = require('./services/piper-launcher');
const { registerIpcHandlers, removeIpcHandlers } = require('./ipc-handlers');

// ──────────────────────────────────────────────
// Application state
// ──────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {StateManager} */
const stateManager = new StateManager();

/** @type {SttService} */
const sttService = new SttService('http://localhost:8100');

/** @type {OllamaService} */
const ollamaService = new OllamaService('http://localhost:11434', 'qwen2.5:3b');

/** @type {TtsService} */
const ttsService = new TtsService('http://localhost:8200');

/** @type {WhisperLauncher} */
const whisperLauncher = new WhisperLauncher({ port: 8100 });

/** @type {PiperLauncher} */
const piperLauncher = new PiperLauncher({ port: 8200 });

// ──────────────────────────────────────────────
// Window creation
// ──────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'Jarvis AI',
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, '..', 'renderer', 'favicon.ico'),
    autoHideMenuBar: true,
    show: false, // Show after ready-to-show to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for preload to use require()
    },
  });

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Show window once content is ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    console.log('[Main] Window is ready');
  });

  // Clean up on close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Register IPC handlers with state manager and backend services
  registerIpcHandlers(stateManager, mainWindow, {
    sttService,
    ollamaService,
    ttsService,
  });

  // Log state changes
  stateManager.on('state-changed', (newState, prevState) => {
    console.log(`[Main] State: ${prevState} -> ${newState}`);
  });

  console.log('[Main] Jarvis AI starting...');

  // Launch servers automatically, then verify health
  launchWhisperServer();
  launchPiperServer();

  // Check Ollama server availability at startup
  checkOllamaServer();
}

/**
 * Launch the Whisper server as a child process and wait for it to become ready.
 * If the server is already running externally, the launcher will detect it via health check.
 */
async function launchWhisperServer() {
  try {
    // First check if the server is already running (e.g. started manually)
    const alreadyRunning = await sttService.isAvailable();
    if (alreadyRunning) {
      console.log('[Main] ✓ Whisper server is already running on http://localhost:8100');
      return;
    }

    // Server not running — launch it
    console.log('[Main] Whisper server not detected. Launching automatically...');
    await whisperLauncher.launch();
    console.log('[Main] ✓ Whisper server launched and ready on http://localhost:8100');
  } catch (err) {
    console.error(`[Main] ✗ Failed to launch Whisper server: ${err.message}`);
    console.error('[Main]   Transcription will not be available.');
  }
}

/**
 * Launch the Piper TTS server as a child process and wait for it to become ready.
 * If the server is already running externally, the launcher will detect it via health check.
 */
async function launchPiperServer() {
  try {
    // First check if the server is already running (e.g. started manually)
    const alreadyRunning = await ttsService.isAvailable();
    if (alreadyRunning) {
      console.log('[Main] ✓ Piper TTS server is already running on http://localhost:8200');
      return;
    }

    // Server not running — launch it
    console.log('[Main] Piper TTS server not detected. Launching automatically...');
    await piperLauncher.launch();
    console.log('[Main] ✓ Piper TTS server launched and ready on http://localhost:8200');
  } catch (err) {
    console.error(`[Main] ✗ Failed to launch Piper TTS server: ${err.message}`);
    console.error('[Main]   TTS will not be available. Responses will be text-only.');
  }
}

/**
 * Check if the Ollama server is running and the model is available.
 * Non-blocking — logs warnings if Ollama is not found or model is missing.
 */
async function checkOllamaServer() {
  const status = await ollamaService.checkStatus();
  if (status.running) {
    if (status.modelAvailable) {
      console.log(`[Main] ✓ Ollama server is running, model '${ollamaService._model}' is available`);
    } else {
      console.warn(
        `[Main] ⚠ Ollama server is running, but model '${ollamaService._model}' was not found.\n` +
          `[Main]   Please download it by running: ollama pull ${ollamaService._model}`
      );
    }
  } else {
    console.warn(
      '[Main] ✗ Ollama server not detected on http://localhost:11434\n' +
        '[Main]   Please make sure Ollama is installed and running locally.'
    );
  }
}

// ──────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();

  // macOS: re-create window when dock icon clicked (not our target, but good practice)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// Quit when all windows are closed (Windows/Linux behavior)
app.on('window-all-closed', () => {
  console.log('[Main] All windows closed, shutting down...');
  whisperLauncher.shutdown();
  piperLauncher.shutdown();
  removeIpcHandlers();
  stateManager.destroy();
  app.quit();
});

// Handle uncaught exceptions gracefully
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
  stateManager.transitionTo('ERROR', { message: err.message });
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
  stateManager.transitionTo('ERROR', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});
