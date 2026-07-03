'use strict';

const http = require('http');

/**
 * SttService — HTTP client for the Faster-Whisper transcription server.
 *
 * Sends raw WAV audio to the whisper server's /transcribe endpoint
 * and returns the transcription text.
 *
 * The server is assumed to be running externally (user starts it manually).
 */
class SttService {
  /**
   * @param {string} serverUrl - Base URL of the whisper server (e.g. 'http://localhost:8100').
   */
  constructor(serverUrl = 'http://localhost:8100') {
    this._url = new URL(serverUrl);
    this._transcribeTimeoutMs = 60000; // 60s — dual-pass transcription on CPU needs headroom
    this._healthTimeoutMs = 5000;      // 5s for health checks
  }

  /**
   * Check if the whisper server is running and the model is loaded.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await this._get('/health', this._healthTimeoutMs);
      return response.status === 'ready';
    } catch {
      return false;
    }
  }

  /**
   * Transcribe a WAV audio buffer to text.
   * @param {Buffer|ArrayBuffer} wavBuffer - WAV audio data (16kHz mono 16-bit PCM).
   * @returns {Promise<{text: string, language: string}>} Transcription result.
   * @throws {Error} If the server is not running, times out, or returns an error.
   */
  async transcribe(wavBuffer) {
    const buffer = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);

    console.log(`[STT] Sending ${(buffer.length / 1024).toFixed(1)} KB to whisper server...`);

    const result = await this._post('/transcribe', buffer, 'audio/wav', this._transcribeTimeoutMs);

    if (result.error) {
      throw new Error(`Whisper error: ${result.error}`);
    }

    console.log(
      '\n[STT]\n' +
      `Language: ${result.language}\n` +
      `Confidence: ${result.language_probability ? result.language_probability.toFixed(2) : 'N/A'}\n` +
      `Transcript: ${result.text}\n`
    );
    return result;
  }

  // ──────────────────────────────────────────────
  // Private HTTP helpers
  // ──────────────────────────────────────────────

  /**
   * Send a GET request.
   * @param {string} path - URL path (e.g. '/health').
   * @param {number} timeoutMs - Request timeout in milliseconds.
   * @returns {Promise<object>} Parsed JSON response.
   */
  _get(path, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: this._url.hostname,
          port: this._url.port,
          path: path,
          timeout: timeoutMs,
        },
        (res) => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON response from ${path}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(this._wrapError(err)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Health check timed out'));
      });
    });
  }

  /**
   * Send a POST request with a binary body.
   * @param {string} path - URL path (e.g. '/transcribe').
   * @param {Buffer} body - Request body.
   * @param {string} contentType - Content-Type header.
   * @param {number} timeoutMs - Request timeout in milliseconds.
   * @returns {Promise<object>} Parsed JSON response.
   */
  _post(path, body, contentType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this._url.hostname,
        port: this._url.port,
        path: path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': contentType,
          'Content-Length': body.length,
        },
      };

      const req = http.request(options, (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Whisper server error (HTTP ${res.statusCode}): ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON response from whisper server'));
          }
        });
      });

      req.on('error', (err) => reject(this._wrapError(err)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Transcription timed out (30s). The audio may be too long.'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Wrap network errors with user-friendly messages.
   * @param {Error} err - Original error.
   * @returns {Error} Wrapped error with actionable message.
   */
  _wrapError(err) {
    if (err.code === 'ECONNREFUSED') {
      return new Error(
        'Whisper server is not responding. It may still be starting up or may have crashed.\n' +
          'The server is managed automatically — try restarting the application.'
      );
    }
    if (err.code === 'ECONNRESET') {
      return new Error('Connection to Whisper server was lost. The server may have crashed.');
    }
    return err;
  }
}

module.exports = { SttService };
