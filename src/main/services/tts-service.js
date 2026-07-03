'use strict';

const http = require('http');

/**
 * TtsService — HTTP client for the Piper TTS server.
 *
 * Sends text to the Piper server's /synthesize endpoint
 * and returns WAV audio bytes.
 *
 * The server is managed by PiperLauncher (or started manually).
 */
class TtsService {
  /**
   * @param {string} serverUrl - Base URL of the Piper server (e.g. 'http://localhost:8200').
   */
  constructor(serverUrl = 'http://localhost:8200') {
    this._url = new URL(serverUrl);
    this._synthesizeTimeoutMs = 30000; // 30s — short LLM responses shouldn't take long
    this._healthTimeoutMs = 5000;      // 5s for health checks
  }

  /**
   * Check if the Piper server is running and the model is loaded.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await this._getJson('/health', this._healthTimeoutMs);
      return response.status === 'ready';
    } catch {
      return false;
    }
  }

  /**
   * Get detailed status from the Piper server.
   * @returns {Promise<{running: boolean, ready: boolean, error: string|null, model: string|null}>}
   */
  async checkStatus() {
    try {
      const response = await this._getJson('/health', this._healthTimeoutMs);
      return {
        running: true,
        ready: response.status === 'ready',
        error: response.error || null,
        model: response.model || null,
      };
    } catch {
      return { running: false, ready: false, error: null, model: null };
    }
  }

  /**
   * Synthesize text to WAV audio.
   * @param {string} text - The text to synthesize.
   * @returns {Promise<Buffer>} WAV audio data as a Node.js Buffer.
   * @throws {Error} If the server is not running, times out, or returns an error.
   */
  async synthesize(text) {
    console.log(`[TTS] Sending text to Piper server (${text.length} chars)...`);

    const payload = JSON.stringify({ text });

    const result = await this._postBinary('/synthesize', payload, 'application/json', this._synthesizeTimeoutMs);

    console.log(`[TTS] Received ${(result.length / 1024).toFixed(1)} KB of WAV audio`);
    return result;
  }

  // ──────────────────────────────────────────────
  // Private HTTP helpers
  // ──────────────────────────────────────────────

  /**
   * Send a GET request and parse JSON response.
   * @param {string} path - URL path (e.g. '/health').
   * @param {number} timeoutMs - Request timeout in milliseconds.
   * @returns {Promise<object>} Parsed JSON response.
   */
  _getJson(path, timeoutMs) {
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
        reject(new Error('TTS health check timed out'));
      });
    });
  }

  /**
   * Send a POST request and return the response as a raw binary Buffer.
   * Handles both binary responses (WAV) and JSON error responses.
   * @param {string} path - URL path (e.g. '/synthesize').
   * @param {string} body - Request body (JSON string).
   * @param {string} contentType - Content-Type header.
   * @param {number} timeoutMs - Request timeout in milliseconds.
   * @returns {Promise<Buffer>} Response body as a Buffer.
   */
  _postBinary(path, body, contentType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this._url.hostname,
        port: this._url.port,
        path: path,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);

          if (res.statusCode !== 200) {
            // Try to parse error JSON from the response body
            let errorMsg = `Piper server error (HTTP ${res.statusCode})`;
            try {
              const errJson = JSON.parse(buffer.toString('utf8'));
              if (errJson.error) {
                errorMsg = errJson.error;
              }
            } catch {
              // Response wasn't JSON — use the raw text
              errorMsg += `: ${buffer.toString('utf8').substring(0, 200)}`;
            }
            reject(new Error(errorMsg));
            return;
          }

          resolve(buffer);
        });
      });

      req.on('error', (err) => reject(this._wrapError(err)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('TTS synthesis timed out. The text may be too long.'));
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
        'Piper TTS server is not responding. It may still be starting up or may have crashed.\n' +
          'The server is managed automatically — try restarting the application.'
      );
    }
    if (err.code === 'ECONNRESET') {
      return new Error('Connection to Piper TTS server was lost. The server may have crashed.');
    }
    return err;
  }
}

module.exports = { TtsService };
