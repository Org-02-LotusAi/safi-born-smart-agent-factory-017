// Qualify: run EVERY effective test of a draft (inherited baseline plus new). Structural tests are
// deterministic; behavioral tests run on the live model through runBehavioralTest. The result is bound
// to the exact draft bytes (sha) so a draft changed afterwards can never ride on an old qualification.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { FactoryError, digestOf } from './canonical.mjs';
import { compile, runStructuralTests } from './compiler.mjs';
import { loadTemplate, loadRegistry, findEntry, parseRef, readJson } from './registry.mjs';
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
 * Does a NEW behavioral test actually discriminate? Run it against the draft's parent (released) definition.
 * discriminates:true  -> it FAILS on the parent on its own expectations, so it can catch the old behaviour;
 * discriminates:false -> it PASSES on the parent too (it would have passed without the lesson: not a draft failure, but the Trainer should know);
 * discriminates:null  -> the parent run failed for a technical reason (model, format, post-check), so nothing can be said.
 */
async function discriminationCheck(parentEffective, test, opts) {
  const r = await runBehavioralTest(parentEffective, test, opts);
  const technical = r.status === 'FAIL' && r.evidence.reasons.some((x) => /^[[a-zA-Z]+]/.test(x));
  const discriminates = r.status === 'PASS' ? false : technical ? null : true;
  return { discriminates, parentStatus: r.status, evidence: r.evidence };
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
  const parentEffective = (() => {
    const p = draft.template.parent;
    return p && effective.tests.some((t) => t.kind === 'behavioral' && t.origin === draftRef) ? compile(`${p.id}@${p.version}`, opts).effective : null;
  })();
  const warnings = [];
  for (const test of effective.tests.filter((t) => t.kind === 'behavioral')) {
    const r = await runBehavioralTest(effective, test, { ...opts, llm });
    const row = { testId: test.id, origin: test.origin, kind: 'behavioral', status: r.status, evidence: r.evidence };
    // A new test that already FAILS needs no discrimination evidence (the draft is not qualified anyway; saves a live call).
    if (parentEffective && test.origin === draftRef && r.status === 'PASS') {
      row.parentCheck = await discriminationCheck(parentEffective, test, { ...opts, llm });
      if (row.parentCheck.discriminates === false) {
        warnings.push(`New test "${test.id}" also passes on the parent version, so it does not prove the lesson changed anything. Consider a sharper test.`);
      } else if (row.parentCheck.discriminates === null) {
        warnings.push(`New test "${test.id}" could not be checked against the parent version (${row.parentCheck.evidence.reasons[0]}).`);
      }
    }
    results.push(row);
  }
  const order = new Map(effective.tests.map((t, i) => [t.id, i]));
  results.sort((a, b) => order.get(a.testId) - order.get(b.testId));
  const record = {
    draftRef,
    draftSha256: digestOf(draft.template),
    effectiveSha256: compiled.effectiveSha256,
    results,
    warnings,
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
      const [dId, dVer] = [d.template.id, d.template.version];
      if (existsSync(approvalPath(ref, opts)) || findEntry(loadRegistry(opts), 'template', dId, dVer)) out.status = 'PUBLISHED';
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

