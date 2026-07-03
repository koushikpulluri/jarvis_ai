'use strict';

const path = require('path');
const { ServiceLauncher } = require('./service-launcher');

/**
 * WhisperLauncher — manages the Faster-Whisper Python server as a child process.
 *
 * Extends ServiceLauncher with Whisper-specific defaults.
 *
 * Usage:
 *   const launcher = new WhisperLauncher();
 *   await launcher.launch();   // Spawns process + waits for health
 *   launcher.shutdown();       // Kills the process
 */
class WhisperLauncher extends ServiceLauncher {
  /**
   * @param {object} [options]
   * @param {string} [options.serverDir] - Path to the whisper-server directory.
   * @param {number} [options.port] - Port for the whisper server (default: 8100).
   * @param {number} [options.healthTimeoutMs] - Max time to wait for health (default: 120s).
   * @param {number} [options.healthPollIntervalMs] - Poll interval (default: 2s).
   */
  constructor(options = {}) {
    // Resolve the server directory relative to the project root
    // From src/main/services/ we go up 3 levels to project root, then into services/whisper-server
    const serverDir = options.serverDir ||
      path.join(__dirname, '..', '..', '..', 'services', 'whisper-server');

    super({
      serviceName: 'Whisper',
      serviceDir: serverDir,
      port: options.port || 8100,
      healthTimeoutMs: options.healthTimeoutMs || 120000,
      healthPollIntervalMs: options.healthPollIntervalMs || 2000,
    });
  }
}

module.exports = { WhisperLauncher };
