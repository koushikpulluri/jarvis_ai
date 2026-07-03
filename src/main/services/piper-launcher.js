'use strict';

const path = require('path');
const { ServiceLauncher } = require('./service-launcher');

/**
 * PiperLauncher — manages the Piper TTS Python server as a child process.
 *
 * Extends ServiceLauncher with Piper-specific defaults and health-check behavior.
 * The Piper server can report a model error (status: 'error') if the voice model
 * is missing or failed to load — in that case, the launcher stops polling and
 * reports the error immediately.
 *
 * Usage:
 *   const launcher = new PiperLauncher();
 *   await launcher.launch();   // Spawns process + waits for health
 *   launcher.shutdown();       // Kills the process
 */
class PiperLauncher extends ServiceLauncher {
  /**
   * @param {object} [options]
   * @param {string} [options.serverDir] - Path to the piper-server directory.
   * @param {number} [options.port] - Port for the Piper server (default: 8200).
   * @param {number} [options.healthTimeoutMs] - Max time to wait for health (default: 120s).
   * @param {number} [options.healthPollIntervalMs] - Poll interval (default: 2s).
   */
  constructor(options = {}) {
    // Resolve the server directory relative to the project root
    // From src/main/services/ we go up 3 levels to project root, then into services/piper-server
    const serverDir = options.serverDir ||
      path.join(__dirname, '..', '..', '..', 'services', 'piper-server');

    super({
      serviceName: 'Piper',
      serviceDir: serverDir,
      port: options.port || 8200,
      healthTimeoutMs: options.healthTimeoutMs || 120000,
      healthPollIntervalMs: options.healthPollIntervalMs || 2000,
    });
  }
}

module.exports = { PiperLauncher };
