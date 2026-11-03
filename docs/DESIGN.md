# Design: the template kernel and how the code enforces it

This document maps SOW 017 sections 2 to 4 onto the code. It is written for engineers and reviewers. Everything named here lives in `lib/` and is reached only through `factory.mjs`, the single creation path; `server/` calls those exports and contains no compile, instantiate, train, qualify or publish logic.

## 1. The formal kernel

```
E(T0) = base
E(T)  = R( E(parent(T)), delta_T )          for every other template T
Constraints(T) ⊇ Constraints(parent(T))
Tests(T)       ⊇ Tests(parent(T))
```

- `E(T)` is the **effective definition** of template T: constraints, tests, knowledge references, skill references, a sealed parameter schema, tools, role guidance and policies, each item tagged with the template that introduced it (`origin`).
- `base` is carried only by the root (T0).
- `R(parent, delta)` is the **typed refinement operator**: it takes the parent's effective definition and a refinement object and returns a new effective definition. It can only add.
- The effective definition has no clocks, no random values and no machine-specific data, so identical exact inputs give an identical hash.

### Where each rule is enforced

| Rule | Enforced by | Failure (error code) |
|---|---|---|
| E(T0) = base | `baseEffective()` in `lib/compiler.mjs` builds E from the root's `base` and top-level lists. Unique ids, known policies, no forbidden or unknown tools, pinned skill and knowledge digests are checked here. | `COLLISION`, `UNKNOWN_POLICY`, `FORBIDDEN_TOOL`, `UNAPPROVED_TOOL`, `SKILL_PIN_MISMATCH`, `KNOWLEDGE_PIN_MISMATCH` |
| E(T) = R(E(parent), delta) | `compile()` walks the chain root to leaf and calls `applyRefinement()` once per child. | any of the below |
| R is typed and additive | `schemas/template.meta.schema.json` allows only `addKnowledgeRefs`, `addSkillRefs`, `addConstraints`, `addTests`, `addParameterFields`, `addRoleGuidance` inside `refinement` and rejects every other property (`additionalProperties: false`). There is no operation that removes, replaces or edits an inherited item. | `TEMPLATE_INVALID` (unknown operation fails) |
| Constraints(T) ⊇ Constraints(parent) | `checkInvariants(parentEff, childEff)` runs inside `compile()` after every level. Each parent constraint id must exist in the child with identical `text` and `policy`. | `INVARIANT_CONSTRAINTS` |
| Tests(T) ⊇ Tests(parent) | Same function: each parent test must exist in the child with an identical canonical form. Also, the meta-schema forces `tests: []` on every child record, so a child cannot even carry a list that could drop inherited tests. | `INVARIANT_TESTS` |
| No privilege elevation | Children have no way to add tools (`addTools` is not an operation, and `base.tools` exists only on the root). `checkInvariants` also rejects any child tool the parent lacks and any dropped policy. | `PRIVILEGE_ELEVATION`, `INVARIANT_CONSTRAINTS` |
| Field collisions fail | `applyRefinement()` refuses to add a constraint, test, knowledge ref, skill ref or parameter field whose id an ancestor already defines. This also stops silent weakening by re-defining an inherited rule. | `COLLISION` |
| Policy ids are runtime-enforced and allowlisted | `checkConstraint()` accepts only ids listed in `lib/policies.mjs` (`POLICIES`). Section 4 below maps each id to its enforcement. | `UNKNOWN_POLICY` |
| Unresolved semantic contradictions | These cannot be detected by a compiler. They are handled by the Trainer reading the draft and the qualification result before approval (`train` shows the change in plain English; `approve` is a deliberate human step). | Trainer rejection |
| Same inputs, same hash | `hashObject(effective)` (RFC 8785 then SHA-256). Tests `A02` compile in one process, in two separate processes and from different working directories. | n/a |
| Distinct agents get distinct ids | `instantiate()` mints `crypto.randomUUID()`. | n/a |

## 2. The SOW Template record, field by field

SOW section 2 lists the Template record as `kind, id, version, parent {id, version, sha256}|null, refinement, parameterSchema, tests, knowledgeRefs, skillRefs`. All nine fields exist on every record (`schemas/template.meta.schema.json`). The root and the children use them differently, which is what keeps the refinement operator additive:

| Field | Root (T0) | Child (T1, T2, and trained revisions) |
|---|---|---|
| `kind` | `"template"` | `"template"` |
| `id`, `version` | its own exact id and semver | its own exact id and semver |
| `parent` | `null` | `{ id, version, sha256 }`: the exact parent, pinned by its digest |
| `refinement` | `{}` | the typed delta (the six `add*` operations) |
| `parameterSchema` | the base structural schema (T0: `candidateName`) | must be `{}`; a child adds fields only through `addParameterFields` |
| `tests` | the base tests | must be `[]`; a child adds tests only through `addTests` |
| `knowledgeRefs` | the base knowledge references | must be `[]`; added through `addKnowledgeRefs` |
| `skillRefs` | the base skill references | must be `[]`; added through `addSkillRefs` |
| `base` (extra, root only) | constraints, tools, role guidance and policies | absent |
| `digest` (extra) | self digest, see section 3 | self digest |

So the root **carries** `parameterSchema`, `tests`, `knowledgeRefs`, `skillRefs` and `base`, and every child **expresses** the same things as typed add-operations inside `refinement`. A `skillRef` is a typed composition reference to a versioned Skill file (`{id, version, sha256}`); skills are never parents.

Operation payloads:

- `addConstraints`: `[{ id, text, policy }]`, `policy` from the allowlist. Adding a constraint also adds its policy to the effective policy set.
- `addTests`: structural tests (`assert` such as `constraintPresent`, `toolAbsent`, `skillPresent`, `parameterRequired`) or behavioral tests (`input` plus `expect` with `mustMatch`, `mustNotMatch`, `sections`, `injectionFlagged`).
- `addParameterFields`: `{ properties, required }` added to the sealed schema (`additionalProperties: false` at the top level, sorted `required`).
- `addKnowledgeRefs`, `addSkillRefs`: references with pinned digests, verified against the registry.
- `addRoleGuidance`: additive plain-English lines.

The three shipped templates:

| Ref | Adds |
|---|---|
| `safi.agent@1.0.0` (T0) | 10 constraints (identity, granted tools only, source-grounded, no fabrication, scoped memory, human approval, no outward action, escalate, run records, documents are data), tools `knowledge_lookup` and `profile_read`, 8 tests |
| `safi.career@1.0.0` (T1) | 4 constraints (truthful resume, evidence over assumption, read the posting literally, consent before processing), knowledge, tests, `consentToHostedModel` |
| `safi.cs-graduate-jobseeker@1.0.0` (T2) | 4 constraints (entry-level scope, academic projects labelled, coding practice honesty, portfolio consented only), four skills, three knowledge documents, 8 tests, the candidate parameter fields |

## 3. Hashing and provenance

- **Canonical form:** RFC 8785 (JSON Canonicalization Scheme) through the `canonicalize` package (`lib/canonical.mjs`, `canonicalJson`).
- **Template digest:** `sha256Hex(canonicalJson(template without its "digest" field))`, lowercase hex. The `digest` property is stored in the file but excluded from the hash, so the hash has no self-reference (`digestOf`). The registry records the same value as `sha256` for templates and skills.
- **Knowledge documents:** `sha256` of the file text with line endings normalised to LF (`hashText`), so Windows and Linux checkouts agree. Each document has a front-matter block (id, version, title, author, date, source) validated by `schemas/knowledge.meta.schema.json`.
- **Effective hash:** `hashObject(effective)`. It covers the template pin, the full ancestry with each ancestor's digest, every constraint, test, knowledge and skill reference with its digest, the sealed parameter schema, tools, role guidance and policies.
- **Parent pin:** a child record stores `parent.sha256`. `resolveChain()` loads the parent from the registry and requires the digest to match. A missing parent, a wrong digest or a changed parent all fail.
- **Instance manifest** (`data/instances/<uuid>/manifest.json`, written once with flag `wx`): instance id, name, template ref with sha256, ancestry, skill and knowledge digests, `effectiveSha256`, `runtimePackageSha256` (hash of `package-lock.json`, the exact dependency set), the model id, effective tools and the creation time. `createdAt` is only in the manifest, never in the hashed effective definition.
- **Runs re-check the pin:** `run()` recompiles the agent's template and requires the hash to equal the manifest. If the release changed, the run fails before any model call.

## 4. Release rules

### Same id, same version, different content is rejected

A released `id@version` is immutable. This is enforced at five points:

1. `loadTemplate()` recomputes the digest of the file and compares it with the `digest` field inside the file (`DIGEST_MISMATCH`) and with the registry entry (`REGISTRY_HASH_MISMATCH`).
2. `addEntry()` in `lib/registry.mjs` refuses a second release of the same kind, id and version with a different hash (`VERSION_CONFLICT`). The identical hash is accepted as a no-op.
3. A child that pins the old parent hash fails if the parent changed (`PARENT_SHA_MISMATCH`).
4. Skill and knowledge pins fail the same way (`SKILL_PIN_MISMATCH`, `KNOWLEDGE_PIN_MISMATCH`).
5. `approve()` refuses to publish a version that is already released (`VERSION_EXISTS`).

### Revisions with the same id (how a trained 1.0.1 exists)

Training produces `safi.cs-graduate-jobseeker@1.0.1` whose parent is `safi.cs-graduate-jobseeker@1.0.0`. The normal rule "each template id appears once in an ancestry" would reject this, so `resolveChain()` allows a repeated id in exactly one case: the parent has the **same id as the child and a strictly lower semver, directly adjacent**. Anything else (a non-adjacent repeat, a lower-version parent, a parent equal to itself) still fails with `DUPLICATE_ID` or `CYCLE`. A trained revision therefore pins the exact older version by digest, inherits everything, and adds only what the Trainer approved.

### Publish order and recovery

`approve()` writes `release/<ref>/{qualification.json, template.json, manifest.json, SHA256SUMS}`, then `templates/<ref>.json`, then appends the registry entry (the commit point), re-compiles from the registry and compares the hash, then writes the approval record. If the process dies between the template file and the registry append, re-running `approve` on a draft whose bytes match the stray file completes the publish; different bytes are refused. Older versions and existing agents are never touched.

## 5. Tool authorization

**Effective tools = tools requested by the template ∩ tools granted by the Office.**

- Templates request tools only at the root (`base.tools`). The approved set is `knowledge_lookup` and `profile_read` (`KNOWN_TOOLS`); `submit_application`, `send_email`, `scrape` and `use_credentials` are forbidden (`FORBIDDEN_TOOLS`) and rejected in templates, in training proposals and in the grants file.
- The Office grants live in `config/office-grants.json`. Training cannot change that file: the training allowlist (`ALLOWED_OPS` in `lib/training.mjs`) is only `addConstraints`, `addTests`, `addRoleGuidance`, and no template operation touches tools.
- `instantiate()` computes `intersectTools(effective.tools, loadOfficeGrants())` and writes the result into the manifest.
- In practice the runtime gives the model **no tools at all** (`tools: []` in `lib/model.mjs`): the knowledge and the profile are placed directly in the prompt, and the model can only return text. Even a granted tool therefore cannot act outward.
- Credentials never enter templates, Git or browser code. `instantiate()` rejects configs containing credential-like strings; the client has no key; the key is read from the server's environment (or the Office's secret store) only.

## 6. Policy enforcement map

Every allowlisted policy id must be enforced at runtime (SOW section 2). `lib/policies.mjs` (`POLICY_ENFORCEMENT`) is the machine-readable version; a test checks that the table covers every id.

| Policy id | Kind | How it is enforced |
|---|---|---|
| `tool-authorization` | structure | Model called with no tools. Effective tools = template ∩ Office grants at compile/instantiate time. Forbidden tools are never grantable. |
| `source-grounding` | post-check (always) | Every evidence id must exist in the profile; `sourcesUsed` must be in the pinned knowledge list. |
| `no-fabrication` | post-check (always) | No years of experience, employment, higher degree, unseen year or unseen skill term without profile support. |
| `scoped-memory` | structure | A run reads only its own instance profile and the pinned template; there is no memory tool; run records are write-once per instance folder. |
| `candidate-approval` | structure | `exportOutput` refuses without an approval file that only `approveOutput` writes, after the candidate approves a PASSED run. |
| `escalate-to-human` | structure | The agent can only draft; nothing leaves the system until a human approves. Scope limits are carried by constraint text and behavioral tests. |
| `run-records` | structure | Every run, pass or fail, is saved as a write-once record (flag `wx`) with model, request id and checks. |
| `no-outward-action` | structure | No tool can send, apply, browse or log in. Key material and addresses copied from documents are also blocked by post-checks. |
| `untrusted-document-data` | post-check (always) | Documents are delimited per call with a random marker; injection heuristics set `safety.injectionDetected`; leaked addresses fail the run. |
| `privacy-consent` | structure | `instantiate` refuses unless `consentToHostedModel` is true and rejects credential-like strings. |
| `capstone-not-employment` | post-check (conditional) | Only when an effective constraint names this policy: the run FAILS if the resume draft or claims present a project, capstone or coursework as paid work, employment, an internship or years of experience. This is what the trained 1.0.1 adds. It is a sentence-level heuristic; see limitations in the README. |
| `evidence-citation` | post-check (always) | Every resume claim and every met or partial match row cites at least one existing evidence id. |
| `identity-disclosure` | post-check (conditional) | Only when an effective constraint names this policy: the run FAILS if the output claims to be a human or a recruiter. |

"Post-check" means a deterministic function in `lib/runtime.mjs` runs on every output and a failure turns the run into a FAIL record with reasons (never a repaired or fabricated answer).

## 7. Training, qualification and approval

- `train(ref, lesson)` asks the model to **propose** `{ refinement, rationale }` as strict JSON. Before anything is written the proposal is validated: only the three allowed operations; policy ids from the allowlist; structural tests limited to known tools; no forbidden-tool words anywhere; no credential-like text (also in the lesson itself); at least one behavioral test with a non-empty `mustMatch` or `mustNotMatch` pattern; fixtures must exist; regexes must compile; and finally the complete template meta-schema. A rejected proposal writes nothing. The draft becomes `drafts/<id>@<patch+1>.json`, pinned to its parent by digest. It is not in the registry.
- `qualify(draftRef)` compiles the draft, runs all structural tests, and runs every behavioral test, inherited and new, against the live model through `runBehavioralTest`. Each new behavioral test that passes on the draft is also run once on the parent; if it passes there too it is flagged as "does not discriminate" (a warning, not a failure). The result is `drafts/<ref>.qualification.json` with per-test PASS or FAIL, origin, request id, excerpt and the draft digest it applies to.
- `approve(draftRef, { trainer })` is an explicit human step: it needs a qualification for the exact draft bytes (`STALE_QUALIFICATION` if the draft changed), every test PASS (`QUALIFICATION_FAILED`), and a named trainer. The server additionally requires the trainer role. There is no self-promotion: nothing in training or qualification can publish.

## 8. Correctness boundary

JSON Schema validates structure. The compiler checks permitted refinements and inherited obligations; evaluation demonstrates bounded Agent behavior. This does NOT prove that every future LLM answer is correct.

(Text from SOW 017 section 2.) Concretely: Ajv strict mode with JSON Schema Draft 2020-12 guarantees that a template or a model answer has the right shape; the compiler guarantees that no child removes or weakens what it inherits; the qualification shows that on the tests we wrote, the live model behaved as required at that time. It does not show that the model will never mislead a candidate. The deterministic post-checks narrow the failure modes (no invented employment, degrees, years or skills; evidence ids must exist; injected instructions flagged) and every output requires the candidate's approval before it can be copied out.

## 9. Failure behavior

- A failed compile, qualification, promotion, deployment or model call is reported as FAIL with a reason in plain English. There is no silent fallback to fabricated model output.
- The old qualified release stays available: publishing only adds a version; nothing is edited in place; Office deployment installs a new release directory and rolls back automatically if the health check fails (`office/install.sh`).
- Run records of failed runs are kept (stage, reasons, truncated raw text) so the failure can be diagnosed.

## 10. Module map

| File | Responsibility |
|---|---|
| `factory.mjs` | Library facade and CLI: compile, instantiate, list, run, approve-output, train, qualify, approve, drafts, verify |
| `lib/canonical.mjs` | RFC 8785 canonicalization, SHA-256, `FactoryError` |
| `lib/validate.mjs` | Ajv 2020 strict instance and error formatting |
| `lib/registry.mjs` | Release registry, loading with digest verification, `addEntry`, knowledge front matter |
| `lib/compiler.mjs` | Chain resolution, `R(parent, delta)`, invariants, structural tests |
| `lib/policies.mjs` | Policy allowlist, enforcement map, tool lists, credential patterns |
| `lib/instance.mjs` | Config validation, Office grants intersection, manifest, private data directory |
| `lib/model.mjs` | The only code that talks to the model API |
| `lib/runtime.mjs` | `run`, pipeline stages, post-checks, behavioral tests, approvals and export |
| `lib/training.mjs`, `lib/qualify.mjs`, `lib/publish.mjs` | train, qualify, approve |
| `lib/queries.mjs` | Read helpers for the API (tree, template view, fixtures) |
| `server/` | Express routes, sessions, jobs. No factory logic. |
| `openapi.yaml` | API contract; parity with the real routes is a test |
| `deploy-office.mjs`, `office/` | Bundle, upload, install, restart, status for the Office |
