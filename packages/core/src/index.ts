/**
 * @axon/core — the contracts every Axon layer agrees on.
 *
 * This package is pure: no Electron, no Node, no React, no vendor SDK. Its
 * only dependency is Zod, for schema validation of tool inputs and events.
 *
 * That purity is not decoration. The main process, the sandboxed renderer and
 * the test suite all import these types, so anything reachable from here would
 * become reachable from the renderer too.
 */

export * from './states.js';
export * from './agent.js';
export * from './risk.js';
export * from './approval.js';
export * from './json.js';
export * from './events.js';
export * from './tool-contract.js';
export * from './speech.js';
export * from './listening.js';
export * from './voice-agent.js';
export * from './browsing.js';
export * from './persistence.js';
export * from './ipc.js';
export * from './interfaces/index.js';
