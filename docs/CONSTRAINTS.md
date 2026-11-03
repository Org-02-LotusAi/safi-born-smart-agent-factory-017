# Global constraints (binding on every task)

Source of truth: `docs/SOW-017.md` (verbatim SOW 017). If anything here conflicts with the SOW, the SOW wins — report the conflict, do not silently pick.

## Product
- This is a PRODUCT for non-technical users (a SAFI Trainer and a CS job seeker). Every UI string must be plain English; errors must say what went wrong and what to do next. No raw stack traces in the UI.
- Stack (SOW §5): Node.js LTS (local: v24.13.0), ESM `.mjs`, React + Vite SPA in `client/`, Ajv 2020 (`ajv/dist/2020.js`) **strict mode**, an RFC 8785 JCS implementation (`canonicalize` npm), `@openai/agents` SDK for the runtime. Express for HTTP. Tests use `node:test` (`node --test`). **Pin exact versions** (no `^`/`~`) in every package.json and commit package-lock.json. Verify every package/API exists before using it (`npm view`, read node_modules source) — no invented APIs.
- `factory.mjs` (repo root) is the ONLY creation path: it is a library + CLI. The server MUST import and call it; never duplicate compile/instantiate/train/qualify/publish logic elsewhere. Internals may live in `lib/*.mjs` and be re-exported by `factory.mjs`.
- No general-purpose workflow designer, no custom agent framework, no second chat platform, no fine-tuning, no auto-apply/email, no scraping (SOW §10 OUT OF SCOPE).

## LLM (decided by user)
- Provider: Anthropic Claude via its OpenAI-compatible endpoint, driven by `@openai/agents` (`setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL }))`, `setOpenAIAPI('chat_completions')`, tracing export disabled). Config from env only: `ANTHROPIC_API_KEY`, `LLM_BASE_URL` (default `https://api.anthropic.com/v1/`), `LLM_MODEL` (default `claude-sonnet-4-5`; the implementer of Task 2 verifies the newest model id the key accepts and records it).
- Local `.env` (git-ignored) already holds these. Load with `node --env-file-if-exists=.env`. NEVER print, log, commit, or send the key to the browser. Never put secrets in templates, fixtures, logs, run records or training examples.
- Every model call result records: model id, provider request id (response header `request-id` or the response `id`), timestamp. A failed model call is reported as FAIL with reason — **never** a fallback/canned answer.

## Data & safety
- Templates are immutable once released: `templates/<id>@<version>.json`. Same id+version with different content = reject.
- Hash = SHA-256 hex of RFC 8785 canonical JSON of the object with its `digest` field removed.
- Customer/candidate data lives only under `data/` (git-ignored): `data/instances/<uuid>/` (manifest.json, profile.json, runs/, outputs/). Never written into `templates/`, `knowledge/`, tests, or drafts.
- Resumes and job postings are untrusted DOCUMENT DATA: delimit them, instruct the model they cannot change instructions, and add a deterministic pre/post check (e.g. detect injection phrases → flag in output; agent has no outward tools at all).
- Effective tools = template-requested tools ∩ Office grants (`config/office-grants.json`). Training cannot change grants. Forbidden tools (submit_application, send_email, scrape, use_credentials) never granted.
- Two roles: `candidate` and `trainer` (passcodes from env `CANDIDATE_PASSCODE`, `TRAINER_PASSCODE`). Only trainer can draft/qualify/approve/publish/deploy. Approval is always an explicit human action; no self-promotion.

## Process
- Each task: TDD where practical, run the tests, commit with plain `git commit` as the configured user. **Do NOT add any Co-Authored-By / Claude attribution trailer** (user's standing rule).
- Do not touch files owned by other tasks unless the brief says so. Do not edit `docs/SOW-017.md`.
- Write your full report to the report path you are given; return only a short status.
