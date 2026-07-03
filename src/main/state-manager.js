'use strict';

const { EventEmitter } = require('events');

/**
 * Application states for the Jarvis AI assistant.
 * @enum {string}
 */
const States = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
  ERROR: 'ERROR',
});

/**
 * Valid state transitions map.
 * Each key is a source state; its value is the set of states it can transition to.
 */
const VALID_TRANSITIONS = Object.freeze({
  [States.IDLE]: new Set([States.LISTENING]),
  [States.LISTENING]: new Set([States.THINKING, States.IDLE]),
  [States.THINKING]: new Set([States.SPEAKING, States.IDLE, States.ERROR]),
  [States.SPEAKING]: new Set([States.IDLE, States.ERROR]),
  [States.ERROR]: new Set([States.IDLE]),
});

/** Duration (ms) before auto-recovering from ERROR → IDLE. */
const ERROR_RECOVERY_TIMEOUT_MS = 3000;

/**
 * StateManager — EventEmitter-based finite state machine for Jarvis AI.
 *
 * Emits:
 *   'state-changed' (newState, previousState) — on every valid transition.
 *
 * Usage:
 *   const sm = new StateManager();
 *   sm.on('state-changed', (newState, prevState) => { ... });
 *   sm.transitionTo(States.LISTENING);
 */
class StateManager extends EventEmitter {
  constructor() {
    super();
    this._state = States.IDLE;
    this._errorRecoveryTimer = null;
  }

  /** @returns {string} Current state. */
  get currentState() {
    return this._state;
  }

  /**
   * Attempt a state transition.
   * @param {string} targetState - The state to transition to.
   * @param {object} [metadata] - Optional metadata (e.g. error message).
   * @returns {boolean} True if the transition succeeded.
   */
  transitionTo(targetState, metadata = {}) {
    // Validate the target is a known state
    if (!States[targetState]) {
      console.error(`[StateManager] Unknown state: "${targetState}"`);
      return false;
    }

    // Allow any state to transition to ERROR
    if (targetState === States.ERROR) {
      return this._performTransition(targetState, metadata);
    }

    // Validate the transition is allowed
    const allowedTargets = VALID_TRANSITIONS[this._state];
    if (!allowedTargets || !allowedTargets.has(targetState)) {
      console.warn(
        `[StateManager] Invalid transition: ${this._state} -> ${targetState}`
      );
      return false;
    }

    return this._performTransition(targetState, metadata);
  }

  /**
   * Execute the state transition and emit the event.
   * @private
   */
  _performTransition(targetState, metadata) {
    const previousState = this._state;
    this._state = targetState;

    // Clear any pending error recovery timer
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }

    console.log(`[StateManager] ${previousState} -> ${targetState}`);
    this.emit('state-changed', targetState, previousState, metadata);

    // Schedule auto-recovery from ERROR state
    if (targetState === States.ERROR) {
      this._errorRecoveryTimer = setTimeout(() => {
        console.log('[StateManager] Auto-recovering from ERROR -> IDLE');
        this.transitionTo(States.IDLE);
      }, ERROR_RECOVERY_TIMEOUT_MS);
    }

    return true;
  }

  /**
   * Reset to IDLE state (bypasses transition validation).
   * Used for hard resets or initialization.
   */
  reset() {
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }
    const previousState = this._state;
    this._state = States.IDLE;
    this.emit('state-changed', States.IDLE, previousState, { reset: true });
  }

  /**
   * Clean up timers when the app shuts down.
   */
  destroy() {
    if (this._errorRecoveryTimer) {
      clearTimeout(this._errorRecoveryTimer);
      this._errorRecoveryTimer = null;
    }
    this.removeAllListeners();
  }
}

module.exports = { StateManager, States };
