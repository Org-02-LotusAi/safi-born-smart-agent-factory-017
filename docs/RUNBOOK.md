# Runbook: operating the SAFI Factory and Office

For the SAFI Trainer or whoever looks after the system. Commands are run in a terminal in the project folder. Anything about AWS needs the Office to exist first (see `AWS-REQUIREMENTS.md`); it has not been provisioned yet.

## 1. Start, stop, check

| Task | How |
|---|---|
| First-time setup | `npm run setup` (installs the server and the web app and builds the web app). Node.js 24 is what we tested; the declared minimum is Node 22.9. |
| Put the secrets in place | Copy `.env.example` to `.env`. Fill in `ANTHROPIC_API_KEY`, `CANDIDATE_PASSCODE`, `TRAINER_PASSCODE`. `.env` is git-ignored. |
| Start | `npm start`. It prints `SAFI Factory is running at http://127.0.0.1:8017`. Open http://localhost:8017. |
| Stop | Ctrl+C in that terminal. Data is on disk, nothing is lost. |
| Different port | `PORT=8100` in `.env` (the server says plainly if a port is taken). |
| Is it up? | Open http://localhost:8017/api/v1/health. You should see `{"status":"ok","mode":"factory",...}` with the model name and the git version. |
| Is the release intact? | `npm run verify` re-hashes every template, skill and knowledge document against `registry/index.json`. |
| Is the code healthy? | `npm test` (a few minutes, no key and no network needed). |
| Is the key valid? | `npm run verify:model`. It makes one tiny call and prints the model id and provider request id. |

The server listens only on `127.0.0.1` unless `HOST` is set. Do not expose it to a network without HTTPS in front of it (set `COOKIE_SECURE=1` when you do).

## 2. Passcodes and who can do what

- Two roles: **job seeker** (passcode `CANDIDATE_PASSCODE`) and **SAFI Trainer** (passcode `TRAINER_PASSCODE`). Everyone also types their name when signing in; it is recorded on the agents they create and on every release the Trainer approves.
- Only the Trainer can propose, qualify, approve and publish a template version, and deploy. A job seeker sees only their own coaches.
- If a passcode is not set in `.env`, the server makes a random one, prints it once at start and saves it to `data/passcodes.local.txt`. Set real passcodes for anything shared.
- Too many wrong passcodes are refused for a while: 8 wrong tries in 10 minutes for the same address, role and name (and 40 for the same address overall). One person's mistakes do not lock out anyone else. Wait ten minutes or restart the server.
- **Behind a load balancer set `TRUST_PROXY`.** The server tells callers apart by their network address. Behind an AWS Application Load Balancer every request arrives from the load balancer, so without the setting all users share one address and one throttle bucket. Set `TRUST_PROXY=1` (one proxy in front) in `.env`, or `"trustProxy": "1"` in `config/office.json` for the Office (the installer writes it to `/etc/safi-office/office.conf`). Leave it `false` when the server is reached directly; `loopback` suits a local tunnel. `true` is refused on purpose, because it would believe any `X-Forwarded-For` a caller sends.
- Changing a passcode: edit `.env`, restart. Existing browser sessions expire after 12 hours; to end them now, also delete `data/session-secret` before restarting.
- Limitation: a person's identity is the name they type plus a shared passcode for their role. Two people who type the same name see the same coaches.

## 3. Resetting demo data

Everything private lives under `data/` (git-ignored): coaches in `data/instances/`, their owners in `data/instance-owners.json`, run records and approved outputs inside each coach folder.

To wipe the demo coaches and start clean (keeps passcodes and sessions):

1. Stop the server.
2. Delete the folder `data/instances` and the file `data/instance-owners.json`.
3. Start the server.

Deleting `data/` entirely also removes generated passcodes and the session secret. Released templates (`templates/`, `registry/`, `release/`) are not touched by any of this.

To throw away a draft that has not been published: stop nothing; delete `drafts/<id>@<version>.json` and the files beside it that start with the same name (`.meta.json`, `.qualification.json`). Published versions cannot be deleted from the registry through the app; see rollback below.

## 4. Teach, qualify, publish (Train and qualify page)

1. Sign in as **I'm a SAFI Trainer**. Open **Train & qualify**.
2. Pick the version to start from. Type the correction in plain words. Press **Propose a refinement**. The AI drafts a rule and a regression test. Nothing is published.
3. Read "What this version adds". Use **Show the raw JSON** to see exactly what would change. The AI can only add rules, tests and guidance, never tools.
4. Press **Run qualification**. It re-runs every inherited test and the new one on the live AI; allow about 3 to 4 minutes. You can leave the page and come back; progress resumes. If the server restarts during a qualification, start it again.
5. Read the results. Every row must be PASS. A warning that a new test "also passes on the parent version" means the test does not prove the new rule; consider re-proposing with a sharper lesson (**Replace the existing draft**).
6. Type your name and press **Approve and publish**, then **Yes, publish it**. The new version appears in the **Template tree**. Existing coaches keep the version they were created from.
7. The release is saved to Git for you. When the server runs in the Factory inside a git work tree, publishing also commits exactly the new `templates/<ref>.json`, `registry/index.json` and `release/<ref>/` as one commit named `publish <ref> approved by <your name>` (plain commit, no trailer), and the page shows the short commit id. If that commit fails (for example git has no user name set) the publish still succeeded: the page shows "Published, but not saved to git" with the reason, and you run `git add templates registry release` and `git commit` yourself. Do not commit `drafts/` without reading it; the lesson text is stored there.

Same thing from the command line:

```
node factory.mjs train safi.cs-graduate-jobseeker@1.0.0 "Never list a capstone or class project as paid work or count it as years of experience."
node factory.mjs drafts
node factory.mjs qualify safi.cs-graduate-jobseeker@1.0.1
node factory.mjs approve safi.cs-graduate-jobseeker@1.0.1 --trainer "Your Name" --git-commit   # --git-commit makes the same git commit; the CLI fails loudly if it cannot
node factory.mjs verify
```

`qualify` exits with code 1 if any test fails; `approve` refuses a draft that was never qualified, was changed after qualification, or has a failing test.

## 5. Deploying to the customer Office

Not possible until the customer provisions the Office; see `docs/AWS-REQUIREMENTS.md` for what to ask them for and what to get back.

One-time:

1. Copy `config/office.example.json` to `config/office.json` and fill in the region, instance id, bucket and the three SSM parameter names the customer sent back. This file holds names only, never keys, and is git-ignored.
2. AWS access comes from your normal AWS sign-in (for example `aws sso login`), delegated by the customer through SOW 016. No access key is stored anywhere in this project.
3. Build the web app: `npm run build`.

Each deployment:

```
node deploy-office.mjs --dry-run      # shows exactly what would be uploaded and run; changes nothing
node deploy-office.mjs --deploy       # uploads the bundle to S3, installs on the Office through SSM, health-checks
node deploy-office.mjs --status       # is the Office online, is the service running and healthy
node deploy-office.mjs --restart      # restarts the Office service and waits for health
```

The same four actions are on the **Office** page for the Trainer. A failed step stops with a plain message including the end of the Office's own error output. The bundle holds only the runtime and the released templates the registry lists; it never holds `.env`, passcodes, `data/`, drafts or `config/office.json`.

The Office runs the same server in "office mode": job seekers can use coaches, but all training routes answer "Training is done in the SAFI Factory, not in the Office." After you publish a new version in the Factory, deploy again so the Office has it; then candidates in the Office can create coaches from the new version.

**Try it without AWS:** `npm run office:local` builds the same bundle, unpacks it to `.office-local/app` and runs it in office mode on http://127.0.0.1:8018 with its own data folder `.office-local/data`. Press Ctrl+C and start it again to see that agents and saved work survive a restart. This is a local simulation, not the customer Office.

## 6. Rollback

- **A deployment fails its health check:** the installer on the Office automatically points the service back at the previous release and tells you so. Nothing to do except read the message.
- **A deployed release turns out to be wrong:** fix forward. Publish a corrected version (a new patch number) and deploy again. To go back at once, on the Office run the installer's rollback by pointing the `current` link at the previous folder in `/opt/safi-office/releases/` and restarting `safi-jobcoach` (three releases are kept).
- **A published template version should not be used any more:** versions are immutable and are not removed. Stop creating coaches from it (pick the older version in **Start from which version?** or on the coach form), publish a better one, and say so in the release notes. Coaches already created from it keep working exactly as before; that is by design.
- **A publish was committed by mistake and not yet shared:** `git revert` the commit. Do this only if no coach has been created from the new version, because those coaches pin it by hash.
- Your own data is safe through all of this: coaches, profiles and run records are never changed by deploy or rollback.

## 7. Logs and records

| What | Where |
|---|---|
| Factory server log | The terminal running `npm start`. One line per request (id, method, path, status, milliseconds). Request bodies and secrets are never logged. An unexpected error shows a code in the app (also in the `X-Request-Id` header); search the terminal for that code. |
| Office server log | On the Office: `journalctl -u safi-jobcoach` (the unit name). The install log is in the SSM command output shown by `deploy-office.mjs`. |
| What the AI was asked and answered per run | `data/instances/<coach id>/runs/<run id>.json` (model, provider request id, hashes of inputs, checks, output or failure reason). |
| Approved outputs | `data/instances/<coach id>/outputs/`. |
| A training lesson and its qualification | `drafts/<id>@<version>.meta.json` and `.qualification.json` (git-ignored). A published version keeps `release/<id>@<version>/` (qualification, manifest, SHA256SUMS). |
| Acceptance results | `ACCEPTANCE.json` and `evidence/<UTC timestamp>/` (see section 9). |

## 8. Rotating the API key

Factory:
1. Create a new key in the Anthropic console (with the spending cap you want).
2. Edit `ANTHROPIC_API_KEY` in `.env`. Restart the server.
3. Run `npm run verify:model` to confirm the new key works.
4. Revoke the old key in the console.

Office:
1. Replace the value of the SSM SecureString named in `config/office.json` (`secretParameterName`) with the new key, using your AWS access. The customer's AWS account owner can also do this.
2. `node deploy-office.mjs --restart`. The service fetches secrets from SSM at every start, so a restart is enough; the key is never written to disk on the Office.
3. `node deploy-office.mjs --status` should report healthy. Revoke the old key.

If a key ever appears in a log, a record or Git, treat it as leaked: revoke it at once, rotate, and tell the SAFI administrator. The acceptance run scans the evidence for key-like text and fails if it finds any.

## 9. Acceptance evidence and the release manifest

```
npm run acceptance              # offline checks; the model checks keep the results of the last --live run (carried forward, with its time)
npm run acceptance -- --live    # also the real-model checks (about 10 minutes, a few cents)
npm run release:manifest        # SHA-256 of every release file plus the git SHA
node scripts/release-manifest.mjs --check
```

`npm run acceptance` writes `ACCEPTANCE.json` and a new folder under `evidence/`. Each check is `PASS`, `FAIL`, `BLOCKED` (cannot run, for example the Office does not exist yet), `PENDING_HUMAN` (needs people), `PARTIAL` (works, but part of the evidence needs a person or a recording; never counted as PASS) or `SKIPPED` (live check never run). A check is never PASS without all its evidence. An offline run keeps the latest live results with a `carriedForward` note naming the live run time and evidence folder. Commit both. The run fails if any evidence file contains text that looks like an API key. ### Handover order

1. Commit all code and docs. `npm run build`.
2. Run the two-person dogfood session (`DOGFOOD.md`). Step 5 publishes v1.0.1 in the real repository; the app commits the release itself. Fill in and sign `DOGFOOD.md` and change its status line to `PERFORMED`. Get the approval line in `MODEL.md` filled in by the customer representative.
3. Commit `DOGFOOD.md` and `MODEL.md`.
4. If the model-backed checks should reflect the final release, run `npm run acceptance -- --live` once now (a few cents, about 10 minutes).
5. `npm run handover`. It regenerates `release/RELEASE-MANIFEST.json` (and `service-expert.manifest.json`), runs the offline acceptance checks, prints the status table, the current git SHA and a checklist of what still needs a person (A09 Office, A11 dogfood, the MODEL.md approval line, any `pendingEvidence`). It never commits.
6. Commit what it regenerated (`git add -A`, check `git status` first, then a plain `git commit`).
7. Run `git rev-parse HEAD`. That is the final handover SHA; record it in the handover note. The manifest names the commit it was built from, so it cannot name its own commit; that is expected.

## 10. Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| Page says the web app is not built | `client/dist` is missing | `npm run build` and reload |
| "Port 8017 is already in use" | Another program (maybe an old server) has the port | Close it, or set `PORT` in `.env` |
| "No AI service key is set" | `.env` has no `ANTHROPIC_API_KEY` | Add it and restart |
| "The AI service rejected the API key" | Key wrong, revoked or from another account | Check `.env`, run `npm run verify:model` |
| "The AI service is busy or over its limit" | Rate or spend limit | Wait a minute and try again; check the spending cap |
| A run says "Blocked by its safety checks" | A deterministic check found something the agent must not say (for example invented years of experience). This is the system working | Read the reasons; rephrase the request; if the check is wrong for a legitimate case, tell the Trainer |
| "That agent was built from X, but that template now compiles to Y" | A released file changed after the agent was created | Restore the original from Git (`git checkout -- templates registry`), run `npm run verify` |
| `DIGEST_MISMATCH` / `PARENT_SHA_MISMATCH` | A template, skill or knowledge file was edited after release | Restore the original; published versions are immutable. Put changes into a new version |
| `STALE_QUALIFICATION` | The draft changed after it was qualified | Qualify again |
| `DRAFT_EXISTS` | A draft for the next version is already there | Use **Replace the existing draft**, or delete the draft files |
| Qualification shows a FAIL | A rule or test does not hold on the live AI | Open the failing row for the reasons; re-propose with a clearer lesson |
| A qualification job disappears after a restart | Jobs live in memory | Start the qualification again |
| "Too many attempts" at sign-in | Wrong passcode too often for that name | Wait ten minutes or restart the server. If everybody is locked out at once, `TRUST_PROXY` is probably not set behind the load balancer (section 2) |
| "Deployment is not installed" / `OFFICE_NOT_CONFIGURED` | `config/office.json` missing or incomplete | Create it from `config/office.example.json`; the message lists the missing fields |
| `OFFICE_AWS_ERROR` | AWS sign-in missing or not allowed | `aws sso login` (or your usual sign-in); confirm the customer's delegated access |
| `npm test` complains about a directory | Wrong test command on Node 24 | Use `npm test` (it passes a file glob) |
| Windows: `npm run office:local` cannot link node_modules | Missing permission for junctions | Run `node scripts/office-local.mjs --install` to install inside `.office-local/app` instead |
