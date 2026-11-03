# Model and provider identification (SOW 017, section 5)

## What the Agent runs on

| Item | Value |
|---|---|
| Provider | Anthropic |
| Model id | `claude-sonnet-5-5` (default; set by `LLM_MODEL` in `.env`, recorded in every agent manifest and every run record) |
| Endpoint | Anthropic's OpenAI-compatible endpoint, `https://api.anthropic.com/v1/` (override with `LLM_BASE_URL`) |
| API style | Chat Completions through the OpenAI-compatible layer |
| Agent SDK | `@openai/agents` 0.21.0 and `openai` 7.47.0 (exact versions pinned in `package.json`, resolved in `package-lock.json`) |
| Credential | `ANTHROPIC_API_KEY`, read from the environment only. Never in templates, Git, logs, run records, training examples or browser code. |
| Tools given to the model | none (`tools: []`). The model can only return text; it cannot send, apply, browse, scrape or log in. |
| Sampling settings | none sent. Newer Sonnet models reject `temperature`, so the call sends only the model id, the token limit and the response format. |
| Structured output | Where the endpoint supports it the call asks for `response_format` `json_schema` (`strict: true`); this was confirmed live on `claude-sonnet-5-5` (an invented key schema was honoured). Every answer is also validated by Ajv against the full schema afterwards, so a model or endpoint that ignores the format cannot slip through. |

How the model id was chosen: `npm run verify:model` tries the candidates newest first (`claude-sonnet-5-5`, then `claude-sonnet-4-5`) with a tiny call and reports the first the key accepts. Both were accepted during the build; `claude-sonnet-5-5` is the default. Change `LLM_MODEL` to move to another model; the model id is pinned per agent at creation (the manifest), so existing agents keep the model they were born with.

## How provider request ids are captured

`lib/model.mjs` wraps `fetch` for the OpenAI client. For each model call it records the provider's `request-id` response header (fallback: `x-request-id`, then the SDK's request id, then the response id) in a per-call store, so that concurrent calls do not mix ids. The id is saved with:

- every run record: `data/instances/<agent-id>/runs/<run-id>.json`, field `provider.requestId` (plus `responseId`, `model`, `usage`, start and finish times, and a hash of the exact instructions sent);
- every behavioral test in a qualification: `drafts/<ref>.qualification.json`, `results[].evidence.requestId`;
- the training proposal: `drafts/<ref>.meta.json`.

The SPA shows the request id in the "Proof" panel of every result. A failed call also keeps its request id when the provider gave one, and is saved as a FAIL record with the reason. There is no canned or fallback answer anywhere: if the model call fails, the run fails.

## Data-transmission disclosure and approval

**Hosted model.** The agent is not run on a SAFI or customer machine. Each run sends the following to Anthropic's API over HTTPS:

1. the agent's instructions (role guidance, rules, the four skills, and the three pinned knowledge documents);
2. the candidate's **profile** (education, projects, skills, contact preferences, name) as stored for that agent;
3. the **resume text** and the **job posting text** the candidate pasted for that run, plus the candidate's typed request;
4. for interview practice, the candidate's typed answer.

Training sends the Trainer's lesson text and the compiled template to the same API. Qualification sends the synthetic test fixtures (Alex Example) only.

**What is not sent:** API keys, passcodes, the Office's secrets, other candidates' data, files other than those listed above.

**Approval and consent.** An agent cannot be created unless the profile carries `consentToHostedModel: true` (the SPA's profile form asks for this; `instantiate` refuses otherwise). SOW 017 section 5 requires hosted-model transmission to be disclosed and approved; this document is that disclosure, and the approval is recorded by the customer's authorised representative:

- Approved by (name, role): ____________________
- Date: ____________________
- Anthropic account and spend cap in force: ____________________

Until that line is filled in, only the synthetic "Alex Example" profile and synthetic or publicly posted job text may be used. Anthropic's own retention and data-use terms for the API apply to anything sent; the customer should review them before sending real candidate data.

**Where results live.** Run records, profiles and approved outputs stay on the machine that runs the agent, under `data/` (Factory, git-ignored) or `/var/lib/safi-office` (customer Office). They are never written into templates, knowledge, drafts or Git.

## Evidence that a live model was used

`ACCEPTANCE.json` and `evidence/<timestamp>/` hold, for each model-backed check (A05 to A08, A10), the model id, provider request ids, token usage and the full run or qualification record. They are produced by `npm run acceptance -- --live` (see `docs/RUNBOOK.md`). Only synthetic data appears in them.
