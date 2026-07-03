'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script — exposes a safe `window.jarvis` API to the renderer process.
 *
 * This is the ONLY bridge between the renderer (untrusted) and the main process.
 * No Node.js APIs are exposed directly to the renderer.
 */
contextBridge.exposeInMainWorld('jarvis', {
  // ──────────────────────────────────────────────
  // Actions (renderer → main)
  // ──────────────────────────────────────────────

  /**
   * Request to start listening for voice input.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  startListening: () => ipcRenderer.invoke('start-listening'),

  /**
   * Stop listening and send captured audio for processing.
   * @param {ArrayBuffer} audioBuffer - WAV audio data from the recorder.
   * @param {object} [meta] - Optional metadata about the recording.
   * @param {number} [meta.durationSec] - Actual recording duration in seconds.
   * @returns {Promise<{ok: boolean, cancelled?: boolean, error?: string}>}
   */
  stopListening: (audioBuffer, meta) => ipcRenderer.invoke('stop-listening', audioBuffer, meta),

  /**
   * Get the current application state.
   * @returns {Promise<string>} One of: IDLE, LISTENING, THINKING, SPEAKING, ERROR
   */
  getState: () => ipcRenderer.invoke('get-state'),

  /**
   * Get application information.
   * @returns {Promise<{name: string, version: string, phase: number, services: object}>}
   */
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  /**
   * Notify main process that audio playback has ended.
   * @param {{ reason: 'finished' | 'skipped' | 'error', message?: string }} data
   * @returns {Promise<{ok: boolean}>}
   */
  notifyPlaybackEnded: (data) => ipcRenderer.invoke('audio-playback-ended', data),

  /**
   * Request to skip current TTS speech playback.
   * @returns {Promise<{ok: boolean}>}
   */
  skipSpeech: () => ipcRenderer.invoke('skip-speech'),

  // ──────────────────────────────────────────────
  // Event listeners (main → renderer)
  // ──────────────────────────────────────────────

  /**
   * Listen for state changes.
   * @param {function({state: string, previousState: string, metadata: object}): void} callback
   * @returns {function} Unsubscribe function.
   */
  onStateChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('state-changed', handler);
    return () => ipcRenderer.removeListener('state-changed', handler);
  },

  /**
   * Listen for user messages (transcribed speech).
   * @param {function({text: string, timestamp: number}): void} callback
   * @returns {function} Unsubscribe function.
   */
  onUserMessage: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('user-message', handler);
    return () => ipcRenderer.removeListener('user-message', handler);
  },

  /**
   * Listen for complete assistant messages.
   * @param {function({text: string, timestamp: number}): void} callback
   * @returns {function} Unsubscribe function.
   */
  onAssistantMessage: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('assistant-message', handler);
    return () => ipcRenderer.removeListener('assistant-message', handler);
  },

  /**
   * Listen for streaming assistant tokens (real-time LLM output).
   * @param {function(string): void} callback - Receives individual token strings.
   * @returns {function} Unsubscribe function.
   */
  onAssistantToken: (callback) => {
    const handler = (_event, token) => callback(token);
    ipcRenderer.on('assistant-token', handler);
    return () => ipcRenderer.removeListener('assistant-token', handler);
  },

  /**
   * Listen for audio playback requests.
   * @param {function(ArrayBuffer): void} callback - Receives WAV audio buffer.
   * @returns {function} Unsubscribe function.
   */
  onPlayAudio: (callback) => {
    const handler = (_event, buffer) => callback(buffer);
    ipcRenderer.on('play-audio', handler);
    return () => ipcRenderer.removeListener('play-audio', handler);
  },

  /**
   * Listen for pipeline performance metrics after each conversation turn.
   * @param {function({recordingTime: number, sttTime: number, llmTime: number, totalTime: number}): void} callback
   * @returns {function} Unsubscribe function.
   */
  onPipelineMetrics: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('pipeline-metrics', handler);
    return () => ipcRenderer.removeListener('pipeline-metrics', handler);
  },

  /**
   * Listen for error events.
   * @param {function({message: string, details?: string}): void} callback
   * @returns {function} Unsubscribe function.
   */
  onError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('error', handler);
    return () => ipcRenderer.removeListener('error', handler);
  },
});
