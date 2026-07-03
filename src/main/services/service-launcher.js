'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

/**
 * ServiceLauncher — reusable base class for managing Python FastAPI servers
 * as child processes.
 *
 * Provides the common lifecycle for Whisper (STT) and Piper (TTS) servers:
 *   - Spawns `python server.py <port>` from a service directory
 *   - Polls the /health endpoint until the server reports ready
 *   - Pipes stdout/stderr to the Electron console with a configurable prefix
 *   - Kills the child process on shutdown (SIGTERM → grace period → SIGKILL)
 *
 * Subclasses should call `super(options)` and may override:
 *   - `_onHealthResponse(json)` — to customize health-check interpretation
 *
 * Usage:
 *   class WhisperLauncher extends ServiceLauncher { ... }
 *   const launcher = new WhisperLauncher({ port: 8100 });
 *   await launcher.launch();
 *   launcher.shutdown();
 */
class ServiceLauncher {
  /**
   * @param {object} options
   * @param {string} options.serviceName - Human-readable name for logging (e.g. 'Whisper', 'Piper').
   * @param {string} options.serviceDir - Absolute path to the service directory containing server.py.
   * @param {number} [options.port] - Port for the server (default: 8100).
   * @param {number} [options.healthTimeoutMs] - Max time to wait for health (default: 120s).
   * @param {number} [options.healthPollIntervalMs] - Poll interval (default: 2s).
   */
  constructor(options = {}) {
    if (!options.serviceName) {
      throw new Error('ServiceLauncher requires a serviceName option');
    }
    if (!options.serviceDir) {
      throw new Error('ServiceLauncher requires a serviceDir option');
    }

    this._serviceName = options.serviceName;
    this._port = options.port || 8100;
    this._healthTimeoutMs = options.healthTimeoutMs || 120000;
    this._healthPollIntervalMs = options.healthPollIntervalMs || 2000;
    this._process = null;
    this._isReady = false;
    this._hasExited = false;

    this._serverDir = options.serviceDir;
    this._serverScript = path.join(this._serverDir, 'server.py');

    // Log prefixes
    this._launcherTag = `[${this._serviceName}Launcher]`;
    this._serverTag = `[${this._serviceName}]`;
  }

  /** @returns {boolean} Whether the server is ready to accept requests. */
  get isReady() {
    return this._isReady;
  }

  /**
   * Launch the server and wait for it to become healthy.
   * @returns {Promise<void>} Resolves when the server is ready.
   * @throws {Error} If the server fails to start or health check times out.
   */
  async launch() {
    if (this._process && !this._hasExited) {
      console.log(`${this._launcherTag} Server process already running.`);
      return;
    }

    console.log(`${this._launcherTag} Spawning: python "${this._serverScript}" ${this._port}`);
    console.log(`${this._launcherTag} Working directory: ${this._serverDir}`);

    this._hasExited = false;
    this._isReady = false;

    // Spawn the Python process
    this._process = spawn('python', [this._serverScript, String(this._port)], {
      cwd: this._serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1', // Force unbuffered output so we see logs immediately
      },
      windowsHide: true, // Don't show a console window on Windows
    });

    // Pipe stdout
    this._process.stdout.setEncoding('utf-8');
    this._process.stdout.on('data', (data) => {
      const lines = data.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        console.log(`${this._serverTag} ${line}`);
      }
    });

    // Pipe stderr
    this._process.stderr.setEncoding('utf-8');
    this._process.stderr.on('data', (data) => {
      const lines = data.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        // Uvicorn logs info to stderr — not all stderr is errors
        console.log(`${this._serverTag} ${line}`);
      }
    });

    // Handle process exit
    this._process.on('exit', (code, signal) => {
      this._hasExited = true;
      this._isReady = false;
      if (code !== null) {
        console.log(`${this._launcherTag} Server process exited with code ${code}`);
      } else {
        console.log(`${this._launcherTag} Server process killed with signal ${signal}`);
      }
    });

    this._process.on('error', (err) => {
      this._hasExited = true;
      this._isReady = false;
      console.error(`${this._launcherTag} Failed to spawn server process: ${err.message}`);
    });

    // Wait for the server to become healthy
    await this._waitForHealth();
  }

  /**
   * Poll the /health endpoint until it returns { status: 'ready' }.
   * @private
   * @returns {Promise<void>}
   * @throws {Error} If the health check times out or the process exits.
   */
  _waitForHealth() {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      console.log(`${this._launcherTag} Waiting for server to become ready (timeout: ${this._healthTimeoutMs / 1000}s)...`);

      const poll = () => {
        // Check if the process has exited unexpectedly
        if (this._hasExited) {
          reject(new Error(`${this._serviceName} server process exited before becoming ready.`));
          return;
        }

        // Check timeout
        const elapsed = Date.now() - startTime;
        if (elapsed >= this._healthTimeoutMs) {
          reject(new Error(
            `${this._serviceName} server did not become ready within ${this._healthTimeoutMs / 1000}s. ` +
            'The model may be missing or the system may be low on memory.'
          ));
          return;
        }

        // Ping /health
        this._checkHealth()
          .then((result) => {
            const outcome = this._onHealthResponse(result);
            if (outcome.ready) {
              this._isReady = true;
              const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
              console.log(`${this._launcherTag} Server is ready! (took ${elapsedSec}s)`);
              resolve();
            } else if (outcome.error) {
              // Server is running but has a fatal error — don't keep polling
              this._isReady = false;
              console.error(`${this._launcherTag} Server reported error: ${outcome.error}`);
              reject(new Error(`${this._serviceName} server error: ${outcome.error}`));
            } else {
              // Still loading — poll again
              setTimeout(poll, this._healthPollIntervalMs);
            }
          })
          .catch(() => {
            // Server not yet accepting connections — poll again
            setTimeout(poll, this._healthPollIntervalMs);
          });
      };

      poll();
    });
  }

  /**
   * Interpret the health check response.
   * Subclasses can override this to customize behavior.
   *
   * @param {object} json - Parsed JSON from /health endpoint.
   * @returns {{ ready: boolean, error?: string }} Interpretation result.
   * @protected
   */
  _onHealthResponse(json) {
    if (json.status === 'ready') {
      return { ready: true };
    }
    if (json.status === 'error') {
      return { ready: false, error: json.error || 'Unknown error' };
    }
    // 'loading' or any other status
    return { ready: false };
  }

  /**
   * Check the /health endpoint.
   * @private
   * @returns {Promise<object>} Parsed JSON response.
   */
  _checkHealth() {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: this._port,
          path: '/health',
          timeout: 3000,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch {
              reject(new Error('Invalid health response'));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Health check timed out'));
      });
    });
  }

  /**
   * Shutdown the server process.
   * Sends SIGTERM first, then SIGKILL after a grace period.
   */
  shutdown() {
    if (!this._process || this._hasExited) {
      console.log(`${this._launcherTag} No server process to shut down.`);
      return;
    }

    console.log(`${this._launcherTag} Shutting down server...`);

    // On Windows, process.kill() sends SIGTERM-equivalent
    try {
      this._process.kill();
    } catch (err) {
      console.error(`${this._launcherTag} Error killing server process: ${err.message}`);
    }

    // Force kill after 5 seconds if still running
    const forceKillTimer = setTimeout(() => {
      if (!this._hasExited) {
        console.warn(`${this._launcherTag} Server did not exit gracefully. Force killing...`);
        try {
          this._process.kill('SIGKILL');
        } catch {
          // Process may have already exited
        }
      }
    }, 5000);

    // Don't let the timer keep the process alive
    if (forceKillTimer.unref) {
      forceKillTimer.unref();
    }
  }
}

module.exports = { ServiceLauncher };
