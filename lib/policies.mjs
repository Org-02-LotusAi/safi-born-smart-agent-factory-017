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

// How each allowlisted policy id is enforced at RUNTIME (SOW section 2: policy ids must be runtime-enforced).
//  - "post-check": a deterministic check in lib/runtime.mjs fails the run. Some are always on; the ones marked
//    conditional only run when the effective definition carries a constraint naming that policy.
//  - "structure": enforced by how the system is built (no code path exists to violate it), described in `how`.
export const POLICY_ENFORCEMENT = Object.freeze({
  'tool-authorization': { kind: 'structure', how: 'The model is called with no tools at all (lib/model.mjs tools: []). Effective tools = template tools intersected with Office grants at compile time; forbidden tools are never grantable.' },
  'source-grounding': { kind: 'post-check', how: 'Always on: every evidence id must exist in the profile and sourcesUsed must be in the pinned knowledge list.' },
  'no-fabrication': { kind: 'post-check', how: 'Always on: no years of experience, employment, higher degree, unseen year or unseen skill term without profile support.' },
  'scoped-memory': { kind: 'structure', how: 'A run reads only its own instance profile and the pinned template; there is no memory tool and run records are write-once per instance folder.' },
  'candidate-approval': { kind: 'structure', how: 'exportOutput refuses without an approval file that only approveOutput writes, after the candidate explicitly approves a PASSED run.' },
  'escalate-to-human': { kind: 'structure', how: 'The agent can only draft; nothing leaves the system until a human approves. Scope limits are carried by the constraint text and covered by behavioral tests.' },
  'run-records': { kind: 'structure', how: 'Every run, pass or fail, is saved as a write-once record (flag wx) with model, request id and checks.' },
  'no-outward-action': { kind: 'structure', how: 'No tool can send, apply, browse or log in (tools: []). Key material and addresses taken from documents are also blocked by post-checks.' },
  'untrusted-document-data': { kind: 'post-check', how: 'Always on: documents are delimited per call; the injection heuristics raise safety.injectionDetected and block leaked addresses.' },
  'privacy-consent': { kind: 'structure', how: 'instantiate refuses a candidate config unless consentToHostedModel is true; credential-like strings are rejected in any config.' },
  'capstone-not-employment': { kind: 'post-check', how: 'Conditional: when an effective constraint names this policy, the run FAILS if the resume draft or claims present a project, capstone or coursework as paid work, employment, an internship or years of experience.' },
  'evidence-citation': { kind: 'post-check', how: 'Always on: every resume claim and every met/partial match row cites at least one existing evidence id.' },
  'identity-disclosure': { kind: 'post-check', how: 'Conditional: when an effective constraint names this policy, the run FAILS if the output claims to be a human or a recruiter.' }
});

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
