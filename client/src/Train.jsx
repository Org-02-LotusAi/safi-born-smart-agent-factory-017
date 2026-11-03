import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, pollJob, ApiError } from './api.js';
import { Button, CopyText, Disclosure, ErrorBox, Explainer, Field, Notice, Pill, Progress, when } from './ui.jsx';
import { Origin, refName } from './Tree.jsx';

const DEFAULT_LESSON = 'Never list a capstone or class project as paid work or count it as years of experience.';
const DRAFT_TONE = { DRAFT: 'warn', FAILED: 'bad', QUALIFIED: 'ok', STALE: 'warn', PUBLISHED: 'ok', INVALID: 'bad' };
const DRAFT_LABEL = { DRAFT: 'Not tested yet', FAILED: 'Failed its tests', QUALIFIED: 'Passed every test', STALE: 'Changed since testing', PUBLISHED: 'Published', INVALID: 'Damaged' };

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable: recovery falls back to the saved results */ } }
};

/** Items that this version adds (not inherited), as readable cards. */
function AddedCards({ view }) {
  const c = view.contract;
  const rules = c.constraints.filter((x) => !x.inherited);
  const tests = c.tests.filter((x) => !x.inherited);
  const guide = c.roleGuidance.filter((x) => !x.inherited);
  const know = c.knowledge.filter((x) => !x.inherited);
  const skills = c.skills.filter((x) => !x.inherited);
  const none = !rules.length && !tests.length && !guide.length && !know.length && !skills.length;
  if (none) return <p className="muted">This version adds nothing on top of its parent.</p>;
  return (
    <div className="cards">
      {rules.map((r) => (
        <article className="card" key={r.id}><p className="card-kind">New rule</p><p>{r.text}</p><p className="muted mono">{r.id}</p></article>
      ))}
      {guide.map((r, i) => (
        <article className="card" key={`g${i}`}><p className="card-kind">New guidance</p><p>{r.text}</p></article>
      ))}
      {tests.map((t) => (
        <article className="card" key={t.id}>
          <p className="card-kind">New check <Pill tone={t.kind === 'behavioral' ? 'brand' : 'neutral'}>{t.kind === 'behavioral' ? 'Tested with the live AI' : 'Structure check'}</Pill></p>
          <p>{t.description}</p><p className="muted mono">{t.id}</p>
        </article>
      ))}
      {know.map((k) => <article className="card" key={k.id}><p className="card-kind">New reference</p><p>{k.id.replace(/-/g, ' ')}</p></article>)}
      {skills.map((k) => <article className="card" key={k.id}><p className="card-kind">New skill</p><p>{k.id.replace(/-/g, ' ')}</p></article>)}
    </div>
  );
}

function Evidence({ ev }) {
  if (!ev) return null;
  return (
    <div className="evidence">
      {ev.reasons?.length ? <ul>{ev.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
      {ev.excerpt ? <blockquote>{ev.excerpt}</blockquote> : null}
      <p className="muted">
        {ev.model ? <>Model <span className="mono">{ev.model}</span>. </> : null}
        {ev.requestId ? <>Request id <CopyText value={ev.requestId} label="provider request id" /> </> : 'No request id recorded.'}
      </p>
    </div>
  );
}

function TestRow({ r, desc }) {
  const pc = r.parentCheck;
  return (
    <li className={`testrow ${r.status === 'PASS' ? 'pass' : 'fail'}`}>
      <div className="testhead">
        <Pill tone={r.status === 'PASS' ? 'ok' : 'bad'}>{r.status === 'PASS' ? 'PASS' : 'FAIL'}</Pill>
        <div>
          <p>{desc || r.testId}</p>
          <p className="muted mono">{r.testId} {r.kind === 'behavioral' ? '' : '(structure check)'}</p>
        </div>
      </div>
      {r.kind === 'behavioral' || r.status !== 'PASS' ? <Disclosure summary="Evidence" open={r.status !== 'PASS'}><Evidence ev={r.evidence} /></Disclosure> : null}
      {pc ? (
        <Disclosure summary={pc.discriminates === true ? 'Proof the lesson matters: the old version fails this test' : pc.discriminates === false ? 'The old version also passes this test' : 'Old version check could not be completed'}>
          <p>{pc.discriminates === true ? 'This test fails on the parent version, so it can tell the difference.' : pc.discriminates === false ? 'It passes on the parent version too, so it may not prove the lesson.' : 'The comparison run failed for a technical reason, so nothing can be said.'}</p>
          <Evidence ev={pc.evidence} />
        </Disclosure>
      ) : null}
    </li>
  );
}

function QualResults({ q, view, draftRef }) {
  const desc = Object.fromEntries((view?.contract.tests || []).map((t) => [t.id, t.description]));
  const groups = [];
  for (const r of q.results) {
    let g = groups.find((x) => x.origin === r.origin);
    if (!g) { g = { origin: r.origin, rows: [] }; groups.push(g); }
    g.rows.push(r);
  }
  const passed = q.results.filter((r) => r.status === 'PASS').length;
  return (
    <div className="qual">
      <div className={`banner ${q.allPass ? 'banner-ok' : 'banner-bad'}`} role="status">
        <strong>{q.allPass ? 'Every test passed.' : `${q.results.length - passed} of ${q.results.length} tests did not pass.`}</strong>
        <span>{passed} of {q.results.length} passed. Tested {when(q.at)}.</span>
      </div>
      {q.warnings?.length ? (
        <Notice tone="warn" title="Worth a look before you publish">
          <ul>{q.warnings.map((w, i) => <li key={i}>{w.replace(/^New test "([^"]+)" also passes on the parent version.*$/, 'The new test "$1" also passes on the old version, so it may not prove the lesson.')}</li>)}</ul>
        </Notice>
      ) : null}
      {groups.map((g) => (
        <section key={g.origin}>
          <h4>{g.origin === draftRef ? 'Tests added by this lesson' : `Inherited from ${refName(g.origin)}`} <span className="count">{g.rows.length}</span></h4>
          <ul className="tests">{g.rows.map((r) => <TestRow key={r.testId} r={r} desc={desc[r.testId]} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function diffItems(a, b, key) {
  const ka = new Set(a.map(key)); const kb = new Set(b.map(key));
  return { added: b.filter((x) => !ka.has(key(x))), removed: a.filter((x) => !kb.has(key(x))) };
}

function Compare({ versions }) {
  const [a, setA] = useState(versions[0]?.ref);
  const [b, setB] = useState(versions[versions.length - 1]?.ref);
  const [views, setViews] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!a || !b) return undefined;
    let cancel = false; setViews(null); setError(null);
    Promise.all([get(`/templates/${encodeURIComponent(a)}`), get(`/templates/${encodeURIComponent(b)}`)]).then((v) => { if (!cancel) setViews(v); }).catch((e) => { if (!cancel) setError(e); });
    return () => { cancel = true; };
  }, [a, b]);
  const sections = views && [
    ['Rules', diffItems(views[0].contract.constraints, views[1].contract.constraints, (x) => x.id), (x) => x.text],
    ['Guidance', diffItems(views[0].contract.roleGuidance, views[1].contract.roleGuidance, (x) => x.text), (x) => x.text],
    ['Checks', diffItems(views[0].contract.tests, views[1].contract.tests, (x) => x.id), (x) => x.description],
    ['References', diffItems(views[0].contract.knowledge, views[1].contract.knowledge, (x) => x.id), (x) => x.id.replace(/-/g, ' ')],
    ['Skills', diffItems(views[0].contract.skills, views[1].contract.skills, (x) => x.id), (x) => x.id.replace(/-/g, ' ')]
  ];
  const same = sections && sections.every(([, d]) => !d.added.length && !d.removed.length);
  const opt = (
    versions.map((v) => <option key={v.ref} value={v.ref}>v{v.version}{v.status === 'DRAFT' ? ' (draft)' : ''}</option>)
  );
  return (
    <div className="panel">
      <div className="form-grid">
        <Field label="Older version">{(x) => <select {...x} value={a} onChange={(e) => setA(e.target.value)}>{opt}</select>}</Field>
        <Field label="Newer version">{(x) => <select {...x} value={b} onChange={(e) => setB(e.target.value)}>{opt}</select>}</Field>
      </div>
      <ErrorBox error={error} />
      {!views && !error ? <p role="status">Comparing...</p> : null}
      {views ? (
        <div aria-live="polite">
          <p className="muted">Fingerprints: <CopyText value={views[0].sha256} short label="older fingerprint" /> and <CopyText value={views[1].sha256} short label="newer fingerprint" /></p>
          {a === b || same ? <Notice title="No differences">These two versions have the same rules, checks and references.</Notice> : sections.map(([title, d, txt]) => (d.added.length || d.removed.length) ? (
            <section key={title}>
              <h4>{title}</h4>
              <ul className="diff">
                {d.added.map((x, i) => <li key={`a${i}`} className="added"><Pill tone="ok">Added</Pill> {txt(x)}</li>)}
                {d.removed.map((x, i) => <li key={`r${i}`} className="removed"><Pill tone="bad">Removed</Pill> {txt(x)}</li>)}
              </ul>
            </section>
          ) : null)}
        </div>
      ) : null}
    </div>
  );
}

export default function Train({ me, initialTemplate }) {
  const [templates, setTemplates] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [base, setBase] = useState(initialTemplate || '');
  const [lesson, setLesson] = useState(DEFAULT_LESSON);
  const [selDraft, setSelDraft] = useState(null);
  const [view, setView] = useState(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [qualifying, setQualifying] = useState(false);
  const [progress, setProgress] = useState('');
  const [needReplace, setNeedReplace] = useState(false);
  const [trainer, setTrainer] = useState(me.name || '');
  const [approving, setApproving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [released, setReleased] = useState(null);
  const [mode, setMode] = useState('train');
  const abort = useRef(null);

  const load = useCallback(async (pick) => {
    try {
      const [t, d] = await Promise.all([get('/templates'), get('/drafts')]);
      setTemplates(t.templates); setDrafts(d.drafts);
      setBase((cur) => {
        if (cur) return cur;
        const rel = t.templates.filter((x) => x.status === 'RELEASED' && x.id === 'safi.cs-graduate-jobseeker');
        return (rel[rel.length - 1] || t.templates.filter((x) => x.status === 'RELEASED').pop())?.ref || '';
      });
      setSelDraft((cur) => pick || cur || d.drafts[0]?.draftRef || null);
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { load(); return () => abort.current?.abort(); }, [load]);

  const draft = drafts.find((d) => d.draftRef === selDraft) || null;
  useEffect(() => {
    if (!selDraft) { setView(null); return undefined; }
    let cancel = false;
    setView(null); setReleased(null); setConfirm(false);
    get(`/templates/${encodeURIComponent(selDraft)}`).then((v) => { if (!cancel) setView(v); }).catch((e) => { if (!cancel) setError(e); });
    return () => { cancel = true; };
  }, [selDraft]);

  // Recover a qualification that was running when the Trainer left this page.
  useEffect(() => {
    if (!selDraft) return undefined;
    const jid = store.get(`safi.job.qualify.${selDraft}`);
    if (!jid || qualifying) return undefined;
    const ac = new AbortController(); abort.current = ac;
    (async () => {
      try {
        const j = await get(`/jobs/${jid}`);
        if (j.status === 'done' || j.status === 'failed') { store.set(`safi.job.qualify.${selDraft}`, null); load(selDraft); return; }
        setQualifying(true); setProgress(j.progressText || '');
        await pollJob(jid, (x) => setProgress(x.progressText || ''), ac.signal);
        store.set(`safi.job.qualify.${selDraft}`, null); await load(selDraft);
      } catch (e) {
        if (e.name === 'AbortError') return;
        store.set(`safi.job.qualify.${selDraft}`, null);
        if (!(e instanceof ApiError && e.code === 'JOB_NOT_FOUND')) setError(e);
        load(selDraft);
      } finally { setQualifying(false); }
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDraft]);

  const propose = async (replace) => {
    if (proposing || !base || !lesson.trim()) return;
    setProposing(true); setError(null); setNeedReplace(false); setProgress('Asking the AI to draft a refinement...');
    const ac = new AbortController(); abort.current = ac;
    try {
      const j = await post('/drafts', { templateRef: base, lesson: lesson.trim(), ...(replace ? { replace: true } : {}) });
      const done = await pollJob(j.jobId, (x) => setProgress(x.progressText || ''), ac.signal);
      await load(done.result.draftRef);
      setMode('train');
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (e.code === 'DRAFT_EXISTS') setNeedReplace(true);
      setError(e);
    } finally { setProposing(false); }
  };
  const qualify = async () => {
    if (qualifying || !selDraft) return;
    setQualifying(true); setError(null); setProgress('Starting...');
    const ac = new AbortController(); abort.current = ac;
    try {
      const j = await post(`/drafts/${encodeURIComponent(selDraft)}/qualify`);
      store.set(`safi.job.qualify.${selDraft}`, j.jobId);
      await pollJob(j.jobId, (x) => setProgress(x.progressText || ''), ac.signal);
      store.set(`safi.job.qualify.${selDraft}`, null);
      await load(selDraft);
    } catch (e) {
      if (e.name === 'AbortError') return;
      store.set(`safi.job.qualify.${selDraft}`, null);
      setError(e); load(selDraft);
    } finally { setQualifying(false); }
  };
  const approve = async () => {
    if (approving) return;
    setApproving(true); setError(null);
    try {
      const r = await post(`/drafts/${encodeURIComponent(selDraft)}/approve`, { trainer: trainer.trim() });
      setReleased(r); setConfirm(false); await load(selDraft);
    } catch (e) { setError(e); } finally { setApproving(false); }
  };

  if (!templates) return error ? <ErrorBox error={error} /> : <p role="status">Loading the training bench...</p>;
  const releasedTpls = templates.filter((t) => t.status === 'RELEASED');
  const q = draft?.qualification || null;
  const canPublish = draft?.status === 'QUALIFIED' && q?.allPass && trainer.trim();
  const sameId = (id) => templates.filter((t) => t.id === id);
  const compareGroup = Object.values(templates.reduce((m, t) => { (m[t.id] ||= []).push(t); return m; }, {})).find((g) => g.length > 1);

  return (
    <div>
      <div className="page-head">
        <p className="eyebrow">Train and qualify</p>
        <h1>Teach the coach something new</h1>
        <p className="lede">Describe a correction in your own words. The AI proposes a careful change, every test runs, and nothing is published until every test passes and you approve it.</p>
      </div>
      <Explainer id="train" title="How this works">
        <ol className="steps">
          <li><strong>Propose.</strong> Write the lesson. The AI turns it into a draft: a new rule and a new test. A draft is never used by anyone.</li>
          <li><strong>Qualify.</strong> Every test, old and new, runs on the live AI. It takes about 3 to 4 minutes.</li>
          <li><strong>Approve and publish.</strong> Only when all tests pass. Your name is recorded on the release.</li>
        </ol>
      </Explainer>
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      {needReplace ? (
        <Notice tone="warn" title="An unpublished draft of the next version already exists">
          <p>You can replace it with this new lesson, or pick the existing draft below.</p>
          <Button variant="secondary" busy={proposing} onClick={() => propose(true)}>Replace the existing draft</Button>
        </Notice>
      ) : null}

      <div className="mode-tabs" role="group" aria-label="Section">
        <button type="button" className={`link-tab ${mode === 'train' ? 'on' : ''}`} aria-pressed={mode === 'train'} onClick={() => setMode('train')}>Train and test</button>
        <button type="button" className={`link-tab ${mode === 'compare' ? 'on' : ''}`} aria-pressed={mode === 'compare'} onClick={() => setMode('compare')} disabled={!compareGroup}>Compare versions</button>
      </div>

      {mode === 'compare' && compareGroup ? <Compare versions={compareGroup} /> : (
        <>
          <section className="panel" aria-label="Step 1: propose">
            <h2>1. Propose a change</h2>
            <div className="form-grid">
              <Field label="Start from which version?">{(a) => (
                <select {...a} value={base} onChange={(e) => setBase(e.target.value)}>
                  {releasedTpls.map((t) => <option key={t.ref} value={t.ref}>{t.title} v{t.version}</option>)}
                </select>
              )}</Field>
            </div>
            <Field label="What should the coach do differently?" hint="Plain words are fine. For example, a mistake you saw it make.">
              {(a) => <textarea {...a} rows={3} value={lesson} maxLength={4000} onChange={(e) => setLesson(e.target.value)} />}
            </Field>
            <div className="actions"><Button busy={proposing} disabled={!lesson.trim() || !base} onClick={() => propose(false)}>Propose a refinement</Button></div>
            <Progress running={proposing} label="The AI is drafting your lesson" text={progress} expect="This usually takes under a minute." />
          </section>

          <section className="panel" aria-label="Drafts">
            <h2>2. Review the draft</h2>
            {!drafts.length ? <p className="muted">No drafts yet. Propose a change above to create one.</p> : (
              <>
                <ul className="runlist draftlist">
                  {drafts.map((d) => (
                    <li key={d.draftRef}>
                      <button type="button" className={`runbtn ${selDraft === d.draftRef ? 'sel' : ''}`} aria-pressed={selDraft === d.draftRef} onClick={() => setSelDraft(d.draftRef)}>
                        <span className="mono">{d.draftRef}</span>
                        <Pill tone={DRAFT_TONE[d.status] || 'neutral'}>{DRAFT_LABEL[d.status] || d.status}</Pill>
                      </button>
                    </li>
                  ))}
                </ul>
                {draft ? (
                  <div className="draftbody">
                    {draft.status === 'INVALID' ? <Notice tone="warn" title="This draft cannot be read">{draft.error}</Notice> : null}
                    {draft.rationale ? <Notice title="Why the AI proposed this">{draft.rationale}</Notice> : null}
                    {!view ? <p role="status">Reading the draft...</p> : (
                      <>
                        <h3>What this version adds</h3>
                        <AddedCards view={view} />
                        <label className="check rawtoggle"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Show the raw JSON</label>
                        {raw ? <pre className="raw" tabIndex={0}>{JSON.stringify(view.raw, null, 2)}</pre> : null}
                      </>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </section>

          {draft && draft.status !== 'PUBLISHED' && draft.status !== 'INVALID' ? (
            <section className="panel" aria-label="Step 3: qualify">
              <h2>3. Run every test</h2>
              {draft.status === 'STALE' ? <Notice tone="warn" title="The draft changed after it was tested">Run the tests again before publishing.</Notice> : null}
              <div className="actions">
                <Button busy={qualifying} onClick={qualify}>{q ? 'Run qualification again' : 'Run qualification'}</Button>
              </div>
              <Progress running={qualifying} label="Running every test on the live AI" text={progress} expect="About 3 to 4 minutes. You can leave this page and come back; the test keeps running." />
              {q && !qualifying ? <QualResults q={q} view={view} draftRef={draft.draftRef} /> : null}
            </section>
          ) : null}

          {draft && draft.status !== 'PUBLISHED' && draft.status !== 'INVALID' ? (
            <section className="panel" aria-label="Step 4: publish">
              <h2>4. Approve and publish</h2>
              {canPublish ? <p>All tests passed for exactly this draft. Publishing creates version {draft.draftRef.split('@')[1]} for everyone.</p>
                : <p className="muted">Publishing unlocks when every test passes for the current draft.</p>}
              <Field label="Your name, recorded on the release">{(a) => <input {...a} value={trainer} maxLength={80} onChange={(e) => setTrainer(e.target.value)} />}</Field>
              {confirm ? (
                <Notice tone="warn" title={`Publish ${draft.draftRef}?`}>
                  <p>This cannot be undone. A published version never changes.</p>
                  <div className="actions">
                    <Button busy={approving} onClick={approve}>Yes, publish it</Button>
                    <Button variant="quiet" onClick={() => setConfirm(false)}>Not yet</Button>
                  </div>
                </Notice>
              ) : <div className="actions"><Button disabled={!canPublish} onClick={() => setConfirm(true)}>Approve and publish</Button></div>}
            </section>
          ) : null}
          {draft?.status === 'PUBLISHED' || released ? (
            <Notice tone="ok" title={`${draft?.draftRef || ''} is published`}>
              <p>{released ? `Approved by ${released.trainer} on ${when(released.at)}. Fingerprint ` : 'This draft has been published. '}{released?.sha256 ? <CopyText value={released.sha256} short label="release fingerprint" /> : null}</p>
              <p>Job seekers can now start coaches from it, and it appears in the Template tree.</p>
            </Notice>
          ) : null}
        </>
      )}
    </div>
  );
}
