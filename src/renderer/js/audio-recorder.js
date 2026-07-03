'use strict';

/**
 * AudioRecorder — captures microphone audio via Web Audio API and encodes to WAV.
 *
 * Uses an AudioWorklet for real-time PCM capture on a dedicated audio thread.
 * On stop, downsamples to 16kHz mono 16-bit PCM and wraps in a RIFF/WAV header.
 *
 * Recording continues indefinitely until the user explicitly stops it.
 * A warning callback fires at 60 seconds but does NOT stop recording.
 *
 * Usage:
 *   const recorder = new AudioRecorder();
 *   await recorder.start();
 *   // ... user speaks ...
 *   const wavBuffer = await recorder.stop();  // ArrayBuffer
 */
class AudioRecorder {
  /** Duration (seconds) after which a warning is emitted. */
  static DURATION_WARNING_SECONDS = 60;

  constructor() {
    /** @type {AudioContext|null} */
    this._audioContext = null;
    /** @type {MediaStream|null} */
    this._mediaStream = null;
    /** @type {AudioWorkletNode|null} */
    this._workletNode = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this._sourceNode = null;
    /** @type {Float32Array[]} */
    this._chunks = [];
    /** @type {boolean} */
    this._isRecording = false;
    /** @type {number} */
    this._sourceSampleRate = 0;
    /** @type {number|null} */
    this._startTime = null;
    /** @type {number|null} */
    this._durationWarningTimer = null;
    /** @type {boolean} */
    this._durationWarningFired = false;
    /** @type {function|null} Callback when recording exceeds the warning threshold. */
    this.onDurationWarning = null;
  }

  /** @returns {boolean} Whether the recorder is currently recording. */
  get isRecording() {
    return this._isRecording;
  }

  /**
   * Get the number of seconds elapsed since recording started.
   * @returns {number} Elapsed seconds, or 0 if not recording.
   */
  getElapsedSeconds() {
    if (!this._isRecording || !this._startTime) {
      return 0;
    }
    return Math.floor((Date.now() - this._startTime) / 1000);
  }

  /**
   * Start recording from the microphone.
   * Requests microphone permission if not already granted.
   * @throws {Error} If mic access is denied or no microphone is found.
   */
  async start() {
    if (this._isRecording) {
      throw new Error('Already recording');
    }

    // ── Step 1: Get microphone access ──
    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        throw new Error('Microphone access denied. Please allow microphone access.');
      }
      if (err.name === 'NotFoundError') {
        throw new Error('No microphone found. Please connect a microphone.');
      }
      throw new Error(`Microphone error: ${err.message}`);
    }

    // ── Step 2: Create AudioContext ──
    this._audioContext = new AudioContext();
    this._sourceSampleRate = this._audioContext.sampleRate;

    // ── Step 3: Load AudioWorklet processor ──
    await this._audioContext.audioWorklet.addModule('js/audio-worklet-processor.js');

    // ── Step 4: Create and connect nodes ──
    this._sourceNode = this._audioContext.createMediaStreamSource(this._mediaStream);
    this._workletNode = new AudioWorkletNode(this._audioContext, 'recorder-processor');

    // Collect PCM chunks from the worklet
    this._chunks = [];
    this._workletNode.port.onmessage = (event) => {
      if (this._isRecording) {
        this._chunks.push(event.data);
      }
    };

    // Connect: microphone -> worklet
    // Do NOT connect worklet to destination — that would cause mic feedback.
    // The worklet still processes because its input (live mic) is active.
    this._sourceNode.connect(this._workletNode);

    this._isRecording = true;
    this._startTime = Date.now();
    this._durationWarningFired = false;

    // Schedule a warning at the duration threshold (does NOT stop recording)
    this._durationWarningTimer = setTimeout(() => {
      if (this._isRecording && !this._durationWarningFired) {
        this._durationWarningFired = true;
        console.log(`[AudioRecorder] Duration warning: recording exceeds ${AudioRecorder.DURATION_WARNING_SECONDS}s`);
        if (this.onDurationWarning) {
          this.onDurationWarning();
        }
      }
    }, AudioRecorder.DURATION_WARNING_SECONDS * 1000);

    console.log(`[AudioRecorder] Recording started at ${this._sourceSampleRate} Hz`);
  }

  /**
   * Stop recording and return the captured audio as a WAV ArrayBuffer.
   * @returns {Promise<ArrayBuffer|null>} WAV data (16kHz mono 16-bit PCM), or null if nothing was recorded.
   */
  async stop() {
    if (!this._isRecording) {
      return null;
    }

    this._isRecording = false;

    // Clear duration warning timer
    if (this._durationWarningTimer) {
      clearTimeout(this._durationWarningTimer);
      this._durationWarningTimer = null;
    }

    // Calculate actual recording duration
    const recordingDurationSec = this._startTime
      ? ((Date.now() - this._startTime) / 1000).toFixed(1)
      : '0.0';

    // ── Step 1: Stop the worklet ──
    if (this._workletNode) {
      this._workletNode.port.postMessage('stop');
      this._sourceNode.disconnect();
      this._workletNode.disconnect();
    }

    // ── Step 2: Stop the microphone ──
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((track) => track.stop());
    }

    // ── Step 3: Save sample rate before closing context ──
    const sourceSampleRate = this._sourceSampleRate;

    // ── Step 4: Close the AudioContext ──
    if (this._audioContext && this._audioContext.state !== 'closed') {
      await this._audioContext.close();
    }

    // ── Step 5: Concatenate all PCM chunks ──
    const totalLength = this._chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalLength === 0) {
      console.log('[AudioRecorder] No audio data captured');
      this._cleanup();
      return null;
    }

    const rawPcm = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this._chunks) {
      rawPcm.set(chunk, offset);
      offset += chunk.length;
    }

    console.log(
      `[AudioRecorder] Captured ${totalLength} samples (${recordingDurationSec}s) at ${sourceSampleRate} Hz`
    );

    // ── Step 6: Downsample to 16kHz ──
    const TARGET_SAMPLE_RATE = 16000;
    const downsampled = this._downsample(rawPcm, sourceSampleRate, TARGET_SAMPLE_RATE);
    console.log(
      `[AudioRecorder] Downsampled: ${rawPcm.length} -> ${downsampled.length} samples`
    );

    // ── Step 7: Encode as WAV ──
    const wavBuffer = this._encodeWav(downsampled, TARGET_SAMPLE_RATE);
    console.log(
      `[AudioRecorder] WAV encoded: ${(wavBuffer.byteLength / 1024).toFixed(1)} KB`
    );

    this._cleanup();
    return wavBuffer;
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  /**
   * Downsample PCM audio from one sample rate to another using linear interpolation.
   * @param {Float32Array} samples - Source samples.
   * @param {number} fromRate - Source sample rate (e.g. 44100).
   * @param {number} toRate - Target sample rate (e.g. 16000).
   * @returns {Float32Array} Downsampled samples.
   */
  _downsample(samples, fromRate, toRate) {
    if (fromRate === toRate) {
      return samples;
    }

    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, samples.length - 1);
      const fraction = srcIndex - low;
      // Linear interpolation between adjacent samples
      result[i] = samples[low] * (1 - fraction) + samples[high] * fraction;
    }

    return result;
  }

  /**
   * Encode Float32 PCM samples as a WAV file (RIFF format).
   * @param {Float32Array} samples - PCM samples in range [-1.0, 1.0].
   * @param {number} sampleRate - Sample rate in Hz.
   * @returns {ArrayBuffer} Complete WAV file as ArrayBuffer.
   */
  _encodeWav(samples, sampleRate) {
    const NUM_CHANNELS = 1;
    const BITS_PER_SAMPLE = 16;
    const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
    const dataLength = samples.length * BYTES_PER_SAMPLE;
    const bufferLength = 44 + dataLength; // 44-byte header + data

    const buffer = new ArrayBuffer(bufferLength);
    const view = new DataView(buffer);

    // ── RIFF header ──
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true); // File size - 8
    this._writeString(view, 8, 'WAVE');

    // ── fmt sub-chunk ──
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);                                       // Sub-chunk size (16 for PCM)
    view.setUint16(20, 1, true);                                        // Audio format (1 = PCM)
    view.setUint16(22, NUM_CHANNELS, true);                             // Number of channels
    view.setUint32(24, sampleRate, true);                                // Sample rate
    view.setUint32(28, sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE, true); // Byte rate
    view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true);          // Block align
    view.setUint16(34, BITS_PER_SAMPLE, true);                          // Bits per sample

    // ── data sub-chunk ──
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // ── PCM data: Float32 → Int16 ──
    let writeOffset = 44;
    for (let i = 0; i < samples.length; i++) {
      // Clamp to [-1.0, 1.0]
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      // Scale to Int16 range
      const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(writeOffset, int16, true);
      writeOffset += BYTES_PER_SAMPLE;
    }

    return buffer;
  }

  /**
   * Write an ASCII string into a DataView at the given byte offset.
   */
  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /**
   * Release all references for garbage collection.
   */
  _cleanup() {
    this._audioContext = null;
    this._mediaStream = null;
    this._workletNode = null;
    this._sourceNode = null;
    this._chunks = [];
    this._startTime = null;
  }
}
