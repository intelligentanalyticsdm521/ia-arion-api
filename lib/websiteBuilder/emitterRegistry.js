/**
 * Emitter registry for the ARION IL website builder.
 * --------------------------------------------------------------------------
 * An emitter is an object with the shape:
 *
 *   {
 *     kind:        string,                   // 'hero' | 'services' | ...
 *     model?:      string,                   // override default Anthropic model
 *     maxTokens?:  number,
 *     buildPrompts({ brand, sectionContext }) → { system, user }
 *     validate(data) → { ok: true, data } | { ok: false, error: { code, message } }
 *     example?:    object                    // an example output for docs / tests
 *   }
 *
 * Phase 1 (this batch) ships hero + services. Adding more is one line per
 * emitter — import + register.
 *
 * The registry is intentionally a simple Map; no plugin discovery yet.
 */

import { createHeroEmitter } from './emitters/heroEmitter.js';
import { createServicesEmitter } from './emitters/servicesEmitter.js';

const _registry = new Map();

export function registerEmitter(emitter) {
  if (!emitter || typeof emitter !== 'object') {
    throw new Error('registerEmitter: emitter must be an object');
  }
  if (!emitter.kind || typeof emitter.kind !== 'string') {
    throw new Error('registerEmitter: emitter.kind required');
  }
  if (typeof emitter.buildPrompts !== 'function') {
    throw new Error(`registerEmitter[${emitter.kind}]: buildPrompts() required`);
  }
  if (typeof emitter.validate !== 'function') {
    throw new Error(`registerEmitter[${emitter.kind}]: validate() required`);
  }
  _registry.set(emitter.kind, emitter);
  return emitter;
}

export function getEmitter(kind) {
  return _registry.get(kind) || null;
}

export function listEmitterKinds() {
  return [...new Set([..._registry.keys()])].sort();
}

export function hasEmitter(kind) {
  return _registry.has(kind);
}

// --- Default registration -------------------------------------------------
// Done at module load so any importer sees a fully populated registry.
// If an emitter constructor needs config (e.g. a custom client), use
// `registerEmitter()` from a wiring file instead of registering here.
registerEmitter(createHeroEmitter());
registerEmitter(createServicesEmitter());
