# SAFI Factory: AI job coaches that show their work

This is SAFI Service 017, the **Born-Smart Agent Factory**. It builds AI helpers ("agents") from a family of rule books that each build on the one before. The first helper it makes is a **CS Job Search Coach** for computer-science graduates who are looking for an entry-level job.

If you are a **job seeker**: the coach compares your profile with a job posting, drafts a truthful resume, practises interview questions with you and plans your first week of searching. It never makes things up, never applies for you and never emails anyone.

If you are a **SAFI Trainer**: you teach the coach a correction in plain words, the system turns it into a new rule plus a test, runs every test on the real AI, and you decide whether to publish the new version. Coaches already created keep the version they were born with.

Everything in the app is plain English. If something goes wrong it tells you what happened and what to do next.

## Start it (three steps)

You need [Node.js](https://nodejs.org/) installed (version 24 is what we tested; 22.9 is the minimum). Open a terminal in this folder and run:

1. `npm run setup`. Installs everything and builds the web app. Takes a few minutes the first time.
2. Copy `.env.example` to `.env` and fill it in: your `ANTHROPIC_API_KEY` (the AI service key), and two passcodes you choose, `CANDIDATE_PASSCODE` for job seekers and `TRAINER_PASSCODE` for the Trainer. The `.env` file stays on your computer and is never uploaded.
3. `npm start`, then open **http://localhost:8017** in Chrome.

To stop it, press Ctrl+C in the terminal.

## Sign in

Pick **I'm looking for a job** or **I'm a SAFI Trainer**, type your name, type the passcode for that role, press **Sign in**. Your name is kept with the coaches you create and with every release you approve.

## For the job seeker

1. **Create your coach.** On **My coach**, fill in your profile (education, projects, skills, what roles and place you want, how you are happy to be contacted). Tick the box to agree that your details can be sent to the AI service. Want to look around first? Press **Fill with Alex Example (synthetic)** to load a made-up graduate. Then press **Create my coach**.
2. **Give it a job.** Paste the text of a real, public job description. Add the link and the date you saw it. Optionally paste your resume. Press **Analyze this job** and wait about a minute. (Prefer to try it with a made-up job? Press **Fill with sample job and resume (synthetic)**.)
3. **Read the results.** Four tabs: **Fit and gaps** (each requirement of the job beside the evidence from your profile, with honest gaps), **Resume draft** (only things your profile supports; unknowns are flagged), **Interview practice** (five questions; type an answer and get feedback), **7-day plan** (a checklist). The "Proof" panel shows which AI model answered, its request id and the version of the coach.
4. **Approve.** Press **I approve these outputs** when you are happy. Only after that can you copy the resume draft or download everything as a file. Nothing is ever sent anywhere for you.
5. **Ask something else.** The **Ask your coach** box lets you type a request instead. Try the example chip *List my capstone as 2 years paid work.* The coach should say no, because your profile shows a school project, not a paid job.
6. **Come back later.** Your earlier analyses are listed under **Past analyses**.

## For the SAFI Trainer

1. **Look around.** The **Template tree** shows the three rule books: the root rules (`safi.agent`), the career coach (`safi.career`) and the CS job search coach (`safi.cs-graduate-jobseeker`). Pick one to see what it inherited from its parent ("Inherited from...") and what it added ("Added here"), plus its checks, skills and knowledge.
2. **Teach.** On **Train & qualify**, choose the version, describe the correction in plain words, press **Propose a refinement**. The AI drafts a rule and a regression test; you can read it as cards or as raw JSON. It cannot give the coach new tools.
3. **Test.** Press **Run qualification**. Every earlier test and the new one run on the real AI (about 3 to 4 minutes). Each test shows PASS or FAIL with its evidence.
4. **Publish.** Only when everything passes, type your name and press **Approve and publish**. A new version (for example 1.0.1) appears. The old one is unchanged, and so are coaches already created from it. When the Factory runs inside a git repository, the release (the new template file, `registry/index.json` and `release/<version>/`) is also saved as one git commit named `publish <version> approved by <your name>`; if that commit fails the publish still stands and the page tells you to commit by hand.
5. **Office.** The **Office** page sends published coaches to the customer's own cloud office. That needs the customer's AWS account set up first (see below).

## One-command instantiation

You can make a coach without the web app. This creates a coach from the CS job seeker template with the synthetic Alex Example profile:

```
node factory.mjs instantiate safi.cs-graduate-jobseeker@1.0.0 fixtures/alex-example.profile.json --name "My CS Job Search Coach"
```

It prints the new coach's permanent id and the fingerprint of the exact rules it is bound to. Run it on a job posting:

```
node factory.mjs run <agent-id> --job job-swe-entry.txt --resume alex-example.resume.txt --task "Compare my profile to this job posting."
```

File names are looked up in the `fixtures/` folder; to use your own job text, give the full path of a text file instead (for example `--job C:\jobs\posting.txt`).

The profile file is the "settings" for the coach (see `fixtures/alex-example.profile.json`). All fixtures are made up; no real person's data is in this repository.

Other commands: `node factory.mjs` with no arguments lists every command (compile, list, train, qualify, approve, drafts, verify and more).

## What this system will not do

It does not apply for jobs, send email, scrape job sites, use anyone's passwords, or promise anyone a job. A coach has no tools that act outward at all. It treats pasted job posts and resumes as information only: instructions hidden inside them are ignored and flagged. You approve every output before you can copy it.

## Honest limitations

- **Who you are is only a typed name plus a shared passcode** for your role. Two people who type the same name see the same coaches. This is fine for a demo and a pilot, not for a public service.
- **The customer's Office is not set up yet.** `deploy-office.mjs` and the Office installer are written and tested against a stand-in, but nothing has been deployed to a real AWS account. Until then, acceptance check A09 is BLOCKED. `npm run office:local` runs a local imitation of the Office. What the AWS account owner needs to provide is in [docs/AWS-REQUIREMENTS.md](docs/AWS-REQUIREMENTS.md).
- **The two-person dogfood session has not happened yet.** Check A11 is waiting for it; the script is in [DOGFOOD.md](DOGFOOD.md).
- **The "capstone is not paid work" check is a heuristic.** It reads each sentence for a project, capstone or coursework word near paid, employment, internship or years-of-experience wording, and skips sentences that say "not" or "unpaid". It can over-block an honest sentence about a paid freelance project and it can miss unusual phrasing. It checks the resume draft and its claims, not the chat message.
- **A test shows behavior on the tests we wrote, not every future answer.** The AI can still be wrong. Every output is a draft that the candidate reads and approves.
- **The AI is a hosted service.** Candidate profile, resume and job text are sent to Anthropic when a coach runs. This needs the candidate's consent (the profile form asks) and the customer's approval; see [MODEL.md](MODEL.md).
- **Qualification is slow and in memory.** It takes minutes, and if the server restarts in the middle, start it again.
- **The AI service can say no.** A run can end as "Blocked by its safety checks" or "the AI service is busy". These are shown as failures with the reason; there is never a made-up answer in their place.
- **Agents made on the command line are not visible in the web app.** `node factory.mjs instantiate` creates an agent with no web owner, so use `node factory.mjs run` for it, or create agents in the app.
- **Not built, by design:** fine-tuning, auto-apply, email, scraping, a general workflow designer, a second chat platform, multi-agent systems. Service 013 (the Service Expert platform) is not connected yet; the exact deferral is recorded in [service-expert.manifest.json](service-expert.manifest.json).

---

# Technical section

## Architecture

```
templates/*.json        immutable, hash-pinned template records (T0 > T1 > T2, plus any published revisions)
skills/*.json           four versioned Skill contracts (referenced by T2, never parents)
knowledge/*.md          three SAFI-authored documents with source metadata
registry/index.json     exact-release index: kind, id, version, path, sha256
schemas/                template, skill, knowledge, instance-manifest, run-output, feedback JSON Schemas (2020-12)
factory.mjs + lib/      the ONLY creation path: compile, instantiate, run, train, qualify, approve (library + CLI)
server/ + openapi.yaml  Express API (/api/v1) that calls factory.mjs exports; OpenAPI 3.1 contract
client/                 React + Vite single-page app (Template tree, My coach, Train & qualify, Office)
deploy-office.mjs       bundle, upload to S3, install through SSM, restart, status
office/                 install.sh, fetch-secrets.sh, systemd unit for the Office
scripts/                acceptance.mjs, handover.mjs, release-manifest.mjs, office-local.mjs, verify-model.mjs, rehash.mjs (dev only)
config/                 office-grants.json (tools the customer allows), office.example.json
fixtures/ + tests/      synthetic profile, resume and job postings; node:test suites
data/                   private runtime data (git-ignored): agents, run records, outputs
drafts/ release/        unpublished drafts (git-ignored metadata) and published release records
```

The design is explained in [docs/DESIGN.md](docs/DESIGN.md): the formal kernel `E(T0)=base, E(T)=R(E(parent), delta)`, how each invariant is enforced, hashing, tool authorization and the policy map. Operating instructions are in [docs/RUNBOOK.md](docs/RUNBOOK.md). Model identification and the data-transmission disclosure are in [MODEL.md](MODEL.md). Rules this build must obey are in [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md); the contract itself is [docs/SOW-017.md](docs/SOW-017.md).

Stack: Node.js (ESM `.mjs`), Express 5.3.0, Ajv 8.20.0 strict mode with JSON Schema 2020-12, `canonicalize` (RFC 8785 JCS) with SHA-256, `@openai/agents` 0.21.0 against Anthropic's OpenAI-compatible endpoint (model `claude-sonnet-5-5`), React 19 + Vite 8. All versions are exact pins; `package-lock.json` is committed.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | `npm ci`, install and build the client |
| `npm start` | Start the server (loads `.env`), http://localhost:8017 |
| `npm run dev` | Vite dev server for the client |
| `npm test` | Offline test suite (stub model, no key; about 190 tests, takes a few minutes) |
| `npm run test:live` | Real-model tests; needs `ANTHROPIC_API_KEY`; spends a few cents |
| `npm run verify` | Re-hash every released template, skill and knowledge file against the registry |
| `npm run verify:model` | Find the newest model id the key accepts |
| `npm run acceptance` | Acceptance checks A01 to A11 offline; writes `ACCEPTANCE.json` and `evidence/<timestamp>/`. The real-model results (A05 to A08, A10) from the last `--live` run are carried forward with their time, not downgraded |
| `npm run acceptance -- --live` | Also the real-model checks (about 10 minutes) |
| `npm run release:manifest` | Write `release/RELEASE-MANIFEST.json` (SHA-256 of every release file, git SHA) |
| `npm run handover` | Final step: regenerate the manifest, run offline acceptance, print the git SHA and the list of items only people can finish (see RUNBOOK section 9) |
| `npm run office:local` | Run the Office bundle locally in office mode on port 8018 |
| `npm run deploy:office -- --dry-run` | Show what a deployment would do (also `--deploy`, `--status`, `--restart`) |

## Environment variables

`ANTHROPIC_API_KEY`, `LLM_BASE_URL` (default `https://api.anthropic.com/v1/`), `LLM_MODEL` (default `claude-sonnet-5-5`), `CANDIDATE_PASSCODE`, `TRAINER_PASSCODE`, `SESSION_SECRET` (optional), `PORT` (8017), `HOST` (127.0.0.1), `SAFI_MODE` (`factory` or `office`), `SAFI_DATA_DIR`, `COOKIE_SECURE`, `TRUST_PROXY` (`false` by default; set `1` behind one load balancer so sign-in throttling sees each caller). See `.env.example`.

## API

`openapi.yaml` is the contract (OpenAPI 3.1, base `/api/v1`) and a test checks that every route in it exists in the server and the other way round. Summary: `GET /health`; `POST/DELETE /session`, `GET /me`; `GET /templates`, `GET /templates/{ref}`, `POST /compile`; `GET /fixtures/demo`; `POST/GET /instances`, `GET /instances/{id}`; runs: `POST /instances/{id}/runs` (returns a job), `GET .../runs`, `GET .../runs/{runId}`, `POST .../approve`, `GET .../export`, `POST .../interview-feedback`; trainer routes: `POST/GET /drafts`, `POST /drafts/{ref}/qualify`, `POST /drafts/{ref}/approve`, `POST /deploy`, `GET /deploy/status`; `GET /jobs/{jobId}`. Mutating calls must send `X-SAFI-Request: 1`. Errors are `{error:{code,message,hint}}`.

## Tests and proof

- `npm test` covers the compiler and its negative cases (A02 to A04), instances, the runtime with a stub model, training, qualification, publishing, the HTTP API (including role gates, isolation and OpenAPI parity), and deployment (bundle, SSM call order with stub clients, local Office restart).
- `npm run test:live` runs the real model for A05, A06, A10 and a full train, qualify, approve cycle in a temporary copy of the repository.
- `npm run acceptance` maps the SOW checks A01 to A11 to evidence files. The latest results are in [ACCEPTANCE.json](ACCEPTANCE.json) with the files in `evidence/`.
- [release/RELEASE-MANIFEST.json](release/RELEASE-MANIFEST.json) lists the SHA-256 of every template, skill, knowledge file, registry, schema, source file and the built client, with the git SHA it was built from. `node scripts/release-manifest.mjs --check` verifies it.
- [service-expert.manifest.json](service-expert.manifest.json) is the scoped Service Expert initialization manifest (SOW, OpenAPI, git SHA, tests) with the Service 013 deferral.

## Deployment to the Office

See [docs/RUNBOOK.md](docs/RUNBOOK.md) section 5 and [docs/AWS-REQUIREMENTS.md](docs/AWS-REQUIREMENTS.md). In short: the customer provisions an instance, role, bucket and secrets; SAFI fills in `config/office.json` (names only, no credentials) and runs `node deploy-office.mjs --dry-run`, then `--deploy`. No permanent access key is used.
