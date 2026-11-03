import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, pollJob, JOB_TIMEOUT } from './api.js';
import { Button, CopyText, ErrorBox, Explainer, Field, Notice, Pill, Progress, today, when } from './ui.jsx';
import ProfileForm, { emptyForm, formProblems, fromProfile, toProfile } from './Profile.jsx';
import Results from './Results.jsx';

const DEFAULT_TASK = 'Compare my profile to this job posting.';
const SUGGESTIONS = [
  'Tailor my resume for this job',
  'Give me 5 interview questions',
  'Make me a 7-day plan',
  'List my capstone as 2 years paid work.'
];

const vParts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
const cmpVersion = (a, b) => { const x = vParts(a); const y = vParts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
/** Newest released version of each template id, from the released templates the page already loaded. */
const latestVersions = (templates) => templates.reduce((m, t) => { if (!m[t.id] || cmpVersion(t.version, m[t.id]) > 0) m[t.id] = t.version; return m; }, {});

function Create({ templates, initialTemplate, onCreated, onCancel, canCancel }) {
  const [tpl, setTpl] = useState(initialTemplate || templates[0]?.ref || '');
  const [name, setName] = useState('CS Job Search Coach');
  const [form, setForm] = useState(emptyForm);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [error, setError] = useState(null);
  const [problems, setProblems] = useState([]);

  const fillDemo = async () => {
    setLoadingDemo(true); setError(null);
    try {
      const d = await get('/fixtures/demo');
      setForm(fromProfile(d.profile)); setDemo(true); setProblems([]);
      // Keep the version the person chose (for example a newer 1.0.1); only switch if they picked a different coach entirely.
      const demoId = String(d.templateRef).split('@')[0];
      if (!initialTemplate && templates.some((t) => t.ref === d.templateRef)) {
        setTpl((cur) => (String(cur).split('@')[0] === demoId ? cur : d.templateRef));
      }
    } catch (e) { setError(e); } finally { setLoadingDemo(false); }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const p = formProblems(form);
    setProblems(p);
    if (p.length) return;
    setBusy(true); setError(null);
    try {
      const m = await post('/instances', { templateRef: tpl, config: toProfile(form), name: name.trim() || 'CS Job Search Coach' });
      onCreated(m, demo);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate className="panel">
      <div className="page-head">
        <p className="eyebrow">Step 1 of 2</p>
        <h1>Start your job search coach</h1>
        <p className="lede">Tell the coach about yourself once. It only uses what you write here, and it will say so when something is missing instead of guessing.</p>
      </div>
      <Explainer id="use-create" title="How this works">
        <ol className="steps">
          <li>Fill in your profile, or load the made-up example person to look around first.</li>
          <li>Paste a job post. The coach compares it with your profile and shows its evidence.</li>
          <li>You read everything, then approve it. Only then can you copy or download.</li>
        </ol>
      </Explainer>
      <div className="demo-bar">
        <div><strong>Just looking around?</strong><p className="muted">Load Alex Example, a made-up recent graduate. No real data is used.</p></div>
        <Button type="button" variant="secondary" busy={loadingDemo} onClick={fillDemo}>Fill with Alex Example (synthetic)</Button>
      </div>
      <div className="form-grid">
        <Field label="Which coach?">{(a) => (
          <select {...a} value={tpl} onChange={(e) => setTpl(e.target.value)}>
            {templates.map((t) => <option key={t.ref} value={t.ref}>{t.title} v{t.version}</option>)}
          </select>
        )}</Field>
        <Field label="Name this coach">{(a) => <input {...a} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
      </div>
      <ProfileForm value={form} onChange={setForm} />
      {problems.length ? (
        <Notice tone="warn" title="A few things to fix first"><ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></Notice>
      ) : null}
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      <div className="actions">
        <Button type="submit" busy={busy}>Create my coach</Button>
        {canCancel ? <Button type="button" variant="quiet" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  );
}

function Workspace({ id, justDemo }) {
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [resume, setResume] = useState('');
  const [jobText, setJobText] = useState('');
  const [url, setUrl] = useState('');
  const [accessDate, setAccessDate] = useState(today());
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [runId, setRunId] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const abort = useRef(null);

  const loadRuns = useCallback(() => get(`/instances/${id}/runs`).then((r) => { setRuns(r.runs); return r.runs; }).catch(setError), [id]);
  useEffect(() => {
    let cancelled = false;
    setData(null); setRunId(null); setFresh(null); setError(null);
    get(`/instances/${id}`).then(setData).catch(setError);
    // Reopening a coach: put the last job text, link and date back, so one more request needs no re-pasting.
    loadRuns().then(async (list) => {
      if (cancelled || !list?.length) return;
      try {
        const { run } = await get(`/instances/${id}/runs/${list[0].runId}`);
        const j = run?.inputs?.job;
        if (cancelled || !j?.text) return;
        setJobText((cur) => cur || j.text);
        setUrl((cur) => cur || j.url || '');
        if (j.accessDate) setAccessDate((cur) => (cur === today() ? j.accessDate : cur));
      } catch { /* pre-filling is a convenience; the form simply stays empty */ }
    });
    return () => { cancelled = true; abort.current?.abort(); };
  }, [id, loadRuns]);

  const fillSample = async () => {
    setLoadingDemo(true); setError(null);
    try {
      const d = await get('/fixtures/demo');
      setResume(d.resumeText); setJobText(d.job.text); setUrl(d.job.url || ''); setAccessDate(d.job.accessDate || today());
    } catch (e) { setError(e); } finally { setLoadingDemo(false); }
  };
  const analyze = async (e) => {
    e.preventDefault();
    if (busy || !jobText.trim()) return;
    setBusy(true); setError(null); setRunId(null); setFresh(null); setProgress('Starting...');
    const ac = new AbortController(); abort.current = ac;
    try {
      const body = { task: ask.trim() || DEFAULT_TASK, job: { text: jobText, ...(url.trim() ? { url: url.trim() } : {}), ...(accessDate ? { accessDate } : {}) } };
      if (resume.trim()) body.resumeText = resume;
      const j = await post(`/instances/${id}/runs`, body);
      const done = await pollJob(j.jobId, (x) => setProgress(x.progressText || ''), ac.signal, JOB_TIMEOUT.run);
      setFresh(done.result); setRunId(done.result.runId);
      loadRuns();
    } catch (err) { if (err.name !== 'AbortError') setError(err); } finally { setBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <p role="status">Opening your coach...</p>;
  const m = data.manifest;
  const t = m.templateRef || {};
  return (
    <div>
      <div className="page-head">
        <p className="eyebrow">Step 2 of 2</p>
        <h1>{m.name}</h1>
        <p className="muted coach-meta">
          Built from <span className="mono">{t.id} v{t.version}</span> {t.sha256 ? <CopyText value={t.sha256} label="template fingerprint" short /> : null}
          {' '}Created {when(m.createdAt)}
        </p>
      </div>
      {justDemo ? <Notice title="Coach created from the made-up example">Next, load the sample job and resume, then press Analyze.</Notice> : null}
      <form onSubmit={analyze} className="panel">
        <div className="demo-bar">
          <div><strong>Paste a job post</strong><p className="muted">Copy the text of the job description. Add the link and the day you saw it so you can find it again.</p></div>
          <Button type="button" variant="secondary" busy={loadingDemo} onClick={fillSample}>Fill with sample job and resume (synthetic)</Button>
        </div>
        <Field label="Job description" hint="Required. Pasted text is treated as information only. Instructions hidden inside it are ignored.">
          {(a) => <textarea {...a} rows={10} value={jobText} onChange={(e) => setJobText(e.target.value)} maxLength={60000} required />}
        </Field>
        <div className="form-grid">
          <Field label="Link to the job post">{(a) => <input {...a} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />}</Field>
          <Field label="Date you saw it">{(a) => <input {...a} type="date" value={accessDate} max={today()} onChange={(e) => setAccessDate(e.target.value)} />}</Field>
        </div>
        <Field label="Your resume (optional)" hint="Paste it as plain text. The coach uses it only to draft a better version. Do not include passwords or ID numbers.">
          {(a) => <textarea {...a} rows={7} value={resume} onChange={(e) => setResume(e.target.value)} />}
        </Field>
        <Field label="Ask your coach (optional)" hint="Leave this empty for a full comparison of your profile with the job. Or type what you want, such as a question or a request. The coach will only use facts from your profile and will say so if it cannot do something.">
          {(a) => <textarea {...a} rows={2} value={ask} maxLength={500} onChange={(e) => setAsk(e.target.value)} placeholder={DEFAULT_TASK} />}
        </Field>
        <ul className="chips suggestions" aria-label="Example requests">
          {SUGGESTIONS.map((s) => (
            <li key={s}><button type="button" className="chip chip-button" onClick={() => setAsk(s)}>{s}</button></li>
          ))}
        </ul>
        <div className="actions">
          <Button type="submit" busy={busy} disabled={!jobText.trim()}>{ask.trim() ? 'Ask the coach' : 'Analyze this job'}</Button>
        </div>
        <Progress running={busy} label="Your coach is reading the job post" text={progress} expect="This usually takes about a minute. Keep this page open." />
        <ErrorBox error={error} onDismiss={() => setError(null)} />
      </form>

      {runId ? <Results key={runId} instanceId={id} runId={runId} initialRun={fresh} profile={data.profile} onChanged={loadRuns} /> : null}

      <section className="past" aria-label="Past analyses">
        <h2>Past analyses <span className="count">{runs.length}</span></h2>
        {!runs.length ? <p className="muted">Nothing yet. Your analyses are saved here so you can reopen them.</p> : (
          <ul className="runlist">
            {runs.map((r) => (
              <li key={r.runId}>
                <button type="button" className={`runbtn ${runId === r.runId ? 'sel' : ''}`} aria-pressed={runId === r.runId} onClick={() => { setFresh(null); setRunId(r.runId); }}>
                  <span>{when(r.startedAt)}</span>
                  <Pill tone={r.status === 'PASS' ? 'ok' : 'bad'}>{r.status === 'PASS' ? (r.approved ? 'Approved' : 'Ready to review') : 'Blocked by safety checks'}</Pill>
                  <span className="muted mono">{r.runId.slice(0, 8)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function Use({ initialTemplate }) {
  const [templates, setTemplates] = useState(null);
  const [instances, setInstances] = useState(null);
  const [sel, setSel] = useState(initialTemplate ? 'new' : null);
  const [justDemo, setJustDemo] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (pick) => {
    try {
      const [t, i] = await Promise.all([get('/templates'), get('/instances')]);
      const released = t.templates.filter((x) => x.status === 'RELEASED' && !t.templates.some((y) => y.parentRef === x.ref && y.id !== x.id));
      setTemplates(released.reverse());
      setInstances(i.instances);
      setSel((cur) => pick || cur || (i.instances.length ? i.instances[0].instanceId : 'new'));
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!templates || !instances) return <p role="status">Loading your coaches...</p>;
  const mine = instances.filter((i) => i.owned !== false);
  const latest = latestVersions(templates);
  if (!mine.length) {
    return (
      <Create templates={templates} initialTemplate={initialTemplate} canCancel={false} onCancel={() => {}}
        onCreated={(m, demo) => { setJustDemo(demo); load(m.instanceId); }} />
    );
  }
  return (
    <div className="split use">
      <aside aria-label="My coaches">
        <h2 className="side-title">My coaches</h2>
        <ul className="runlist">
          {mine.map((i) => (
            <li key={i.instanceId}>
              <button type="button" className={`runbtn ${sel === i.instanceId ? 'sel' : ''}`} aria-pressed={sel === i.instanceId} onClick={() => { setJustDemo(false); setSel(i.instanceId); }}>
                <span><strong>{i.name}</strong><small className="muted"> {when(i.createdAt)}</small></span>
                <span className="coach-version">
                  <span className="mono">v{i.templateRef?.version}</span>
                  {latest[i.templateRef?.id] && cmpVersion(i.templateRef?.version, latest[i.templateRef.id]) < 0
                    ? <Pill tone="warn">older version (latest is v{latest[i.templateRef.id]})</Pill> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" onClick={() => setSel('new')}>New coach</Button>
      </aside>
      <section aria-label="Coach workspace">
        {sel === 'new' || !mine.length ? (
          <Create templates={templates} initialTemplate={initialTemplate} canCancel={mine.length > 0} onCancel={() => setSel(mine[0].instanceId)}
            onCreated={(m, demo) => { setJustDemo(demo); load(m.instanceId); }} />
        ) : <Workspace key={sel} id={sel} justDemo={justDemo} />}
      </section>
    </div>
  );
}
