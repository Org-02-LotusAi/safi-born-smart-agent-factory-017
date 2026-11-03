// Runtime-enforced policy ids, tool allowlist and semantic constants.
// A constraint may only name a policy listed here; anything else FAILS at compile time.
export const POLICIES = Object.freeze([
  'tool-authorization',
  'source-grounding',
  'no-fabrication',
  'scoped-memory',
  'candidate-approval',
  'escalate-to-human',
  'run-records',
  'no-outward-action',
  'untrusted-document-data',
  'privacy-consent',
  'capstone-not-employment',
  'evidence-citation',
  'identity-disclosure'
]);

// Tools a template may request (read-only, nothing acts outward).
export const KNOWN_TOOLS = Object.freeze(['knowledge_lookup', 'profile_read']);

// Never grantable, never requestable (SOW section 3 and CONSTRAINTS.md).
export const FORBIDDEN_TOOLS = Object.freeze(['submit_application', 'send_email', 'scrape', 'use_credentials']);

// Permitted contact preference values (semantic check at instantiate time).
export const CONTACT_CHANNELS = Object.freeze(['email', 'phone', 'sms', 'in-app']);

// Strings that look like credentials are refused anywhere in a candidate config.
export const CREDENTIAL_PATTERNS = Object.freeze([
  /\b(api[_-]?key|password|passcode|secret|access[_-]?token|auth[_-]?token)\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bbearer\s+[A-Za-z0-9._-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]);

export const isPolicy = (id) => POLICIES.includes(id);
