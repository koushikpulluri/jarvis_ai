'use strict';

const http = require('http');

/**
 * OllamaService — HTTP client for local Ollama server.
 *
 * Connects to http://localhost:11434 and provides chat completions with streaming support.
 */
class OllamaService {
  /**
   * @param {string} serverUrl - Base URL of Ollama (default: http://localhost:11434)
   * @param {string} model - Model name to use (default: qwen2.5:3b)
   */
  constructor(serverUrl = 'http://localhost:11434', model = 'qwen2.5:3b') {
    this._url = new URL(serverUrl);
    this._model = model;
    this._timeoutMs = 60000;       // 60s timeout for streaming completion responses
    this._healthTimeoutMs = 5000;   // 5s timeout for tags check
  }

  /**
   * Check if Ollama is running and has the target model installed.
   * @returns {Promise<{running: boolean, modelAvailable: boolean}>}
   */
  async checkStatus() {
    try {
      const response = await this._get('/api/tags', this._healthTimeoutMs);
      if (response && Array.isArray(response.models)) {
        const found = response.models.some(
          (m) => m.name === this._model || m.name.startsWith(this._model + ':')
        );
        return { running: true, modelAvailable: found };
      }
      return { running: true, modelAvailable: false };
    } catch {
      return { running: false, modelAvailable: false };
    }
  }

  /**
   * Send message history to Ollama and stream the response tokens.
   * @param {Array<{role: string, content: string}>} messages - Current conversation history.
   * @param {function(string): void} onToken - Callback for each chunk.
   * @returns {Promise<string>} The complete collected assistant response.
   */
  chat(messages, onToken) {
    return new Promise((resolve, reject) => {
      console.log(`[OllamaService] Starting stream request for model '${this._model}'...`);
      const payload = JSON.stringify({
        model: this._model,
        messages: messages,
        stream: true,
      });

      const options = {
        hostname: this._url.hostname,
        port: this._url.port,
        path: '/api/chat',
        method: 'POST',
        timeout: this._timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      let fullText = '';
      let buffer = '';
      let tokenCount = 0;

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errData = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (errData += chunk));
          res.on('end', () => {
            const errorMsg = `Ollama returned HTTP ${res.statusCode}: ${errData}`;
            console.error(`[OllamaService] Stream request failed with HTTP ${res.statusCode}`);
            reject(new Error(errorMsg));
          });
          return;
        }

        console.log('[OllamaService] Stream response started (HTTP 200)');
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep last incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.message && parsed.message.content) {
                  const content = parsed.message.content;
                  fullText += content;
                  tokenCount++;
                  if (onToken) {
                    onToken(content);
                  }
                }
              } catch (err) {
                console.error('[OllamaService] Error parsing NDJSON chunk:', err.message);
              }
            }
          }
        });

        res.on('end', () => {
          // Parse final chunk if remaining
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer);
              if (parsed.message && parsed.message.content) {
                const content = parsed.message.content;
                fullText += content;
                tokenCount++;
                if (onToken) {
                  onToken(content);
                }
              }
            } catch {
              // Ignore partial chunk at end
            }
          }
          console.log(`[OllamaService] Stream completed successfully. Received ${tokenCount} tokens.`);
          resolve(fullText);
        });
      });

      req.on('error', (err) => {
        console.error('[OllamaService] Stream socket error:', err.message);
        reject(this._wrapError(err));
      });

      req.on('timeout', () => {
        console.warn('[OllamaService] Stream request timed out');
        req.destroy();
        reject(new Error('Ollama chat response timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  // ──────────────────────────────────────────────
  // Private HTTP helpers
  // ──────────────────────────────────────────────

  /**
   * Helper to perform a GET request and parse JSON.
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

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Ollama tags request timed out'));
      });
    });
  }

  /**
   * Wrap network errors with user-friendly logs.
   */
  _wrapError(err) {
    if (err.code === 'ECONNREFUSED') {
      return new Error(
        'Ollama is not running. Please start Ollama locally on your system.'
      );
    }
    return err;
  }
}

module.exports = { OllamaService };
