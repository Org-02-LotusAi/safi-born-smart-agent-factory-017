// Qualify: run EVERY effective test of a draft (inherited baseline plus new). Structural tests are
// deterministic; behavioral tests run on the live model through runBehavioralTest. The result is bound
// to the exact draft bytes (sha) so a draft changed afterwards can never ride on an old qualification.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { FactoryError, digestOf } from './canonical.mjs';
import { compile, runStructuralTests } from './compiler.mjs';
import { loadTemplate, parseRef, readJson } from './registry.mjs';
import { callModel } from './model.mjs';
import { runBehavioralTest } from './runtime.mjs';
import { draftsDir, draftPath, metaPath, qualificationPath, approvalPath } from './training.mjs';

/** Straight quotes/apostrophes so regex tests do not miss "can’t" or “quoted” text. */
export function normaliseQuotes(s) {
  return String(s ?? '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, "'");
}

/** Wrap a model function so its text has straight quotes (JSON-safe: curly quotes are never JSON syntax). */
export function withNormalisedQuotes(fn) {
  return async (args) => {
    const r = await fn(args);
    return { ...r, text: normaliseQuotes(r.text) };
  };
}

export function loadDraft(draftRef, opts = {}) {
  const { id, version } = parseRef(draftRef);
  if (!existsSync(draftPath(draftRef, opts))) {
    throw new FactoryError(`There is no draft ${draftRef}. Create one first with: node factory.mjs train <template> "<lesson>".`, 'DRAFT_NOT_FOUND');
  }
  return loadTemplate(id, version, { ...opts, allowDraft: true }); // verifies the draft's own digest
}

/**
 * qualify(draftRef, opts) -> qualification record (also written to drafts/<ref>.qualification.json)
 * opts: { root, dataDir, model, llm (stub) }
 */
export async function qualify(draftRef, opts = {}) {
  const draft = loadDraft(draftRef, opts);
  const compiled = compile(draftRef, { ...opts, allowDraft: true });
  const { effective } = compiled;
  const llm = withNormalisedQuotes(opts.llm ?? callModel);
  const results = [...runStructuralTests(effective)];
  for (const test of effective.tests.filter((t) => t.kind === 'behavioral')) {
    const r = await runBehavioralTest(effective, test, { ...opts, llm });
    results.push({ testId: test.id, origin: test.origin, kind: 'behavioral', status: r.status, evidence: r.evidence });
  }
  const order = new Map(effective.tests.map((t, i) => [t.id, i]));
  results.sort((a, b) => order.get(a.testId) - order.get(b.testId));
  const record = {
    draftRef,
    draftSha256: digestOf(draft.template),
    effectiveSha256: compiled.effectiveSha256,
    results,
    allPass: results.length === effective.tests.length && results.length > 0 && results.every((r) => r.status === 'PASS'),
    at: new Date().toISOString()
  };
  writeFileSync(qualificationPath(draftRef, opts), JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function readQualification(draftRef, opts = {}) {
  const file = qualificationPath(draftRef, opts);
  return existsSync(file) ? readJson(file, `Qualification for ${draftRef}`) : null;
}

/** Plain-English status of every draft: DRAFT, FAILED, QUALIFIED, STALE (changed after qualifying) or PUBLISHED. */
export function listDrafts(opts = {}) {
  const dir = draftsDir(opts);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((f) => !/\.(meta|qualification|approval)\.json$/.test(f)).filter((f) => /@\d+\.\d+\.\d+\.json$/.test(f));
  return names.map((f) => {
    const ref = f.replace(/\.json$/, '');
    const out = { draftRef: ref, status: 'DRAFT' };
    try {
      const d = loadDraft(ref, opts);
      const q = readQualification(ref, opts);
      if (existsSync(approvalPath(ref, opts))) out.status = 'PUBLISHED';
      else if (q) out.status = q.draftSha256 !== digestOf(d.template) ? 'STALE' : q.allPass ? 'QUALIFIED' : 'FAILED';
      if (q) out.qualifiedAt = q.at;
      if (existsSync(metaPath(ref, opts))) out.rationale = readJson(metaPath(ref, opts), 'Draft notes').rationale;
    } catch (e) {
      out.status = 'INVALID';
      out.error = e.message;
    }
    return out;
  });
}

