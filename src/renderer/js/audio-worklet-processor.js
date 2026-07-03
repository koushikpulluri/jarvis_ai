'use strict';

/**
 * AudioWorklet Processor — runs on the audio rendering thread.
 *
 * Captures raw Float32 PCM frames from the microphone and posts them
 * to the main thread via MessagePort. Each message contains a copy
 * of the channel data (mono, channel 0).
 *
 * Lifecycle:
 *   - Created when AudioRecorder.start() adds the module and creates the node.
 *   - Posts PCM chunks continuously while recording.
 *   - Stopped when it receives a 'stop' message from the main thread.
 *   - Returning false from process() removes the node from the audio graph.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._isRecording = true;

    this.port.onmessage = (event) => {
      if (event.data === 'stop') {
        this._isRecording = false;
      }
    };
  }

  /**
   * Process audio frames.
   * @param {Float32Array[][]} inputs - Input audio data [input][channel][sample].
   * @returns {boolean} Return true to keep processing, false to stop.
   */
  process(inputs) {
    if (!this._isRecording) {
      return false; // Remove from audio graph
    }

    const input = inputs[0]; // First input
    if (input && input.length > 0) {
      const channelData = input[0]; // Channel 0 (mono)
      if (channelData && channelData.length > 0) {
        // Clone the data — the original buffer is reused by the audio engine
        this.port.postMessage(new Float32Array(channelData));
      }
    }

    return true; // Keep processing
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
