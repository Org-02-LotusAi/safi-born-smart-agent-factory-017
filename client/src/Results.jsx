import { useEffect, useMemo, useState } from 'react';
import { get, post } from './api.js';
import { Button, CopyText, Disclosure, ErrorBox, Notice, Pill, Progress, TabPanel, Tabs, download, shortSha, when } from './ui.jsx';

const STATUS = {
  met: { tone: 'ok', label: 'Met' },
  partial: { tone: 'warn', label: 'Partly met' },
  gap: { tone: 'bad', label: 'Gap' },
  unknown: { tone: 'neutral', label: 'Not enough information' }
};

const UNKNOWN_STATUS = { tone: 'neutral', label: 'Not enough information' };
const st = (s) => STATUS[s] || UNKNOWN_STATUS;

export function evidenceLabels(profile) {
  const m = {};
  if (!profile) return m;
  for (const e of profile.education || []) m[e.id] = `${e.degree}, ${e.institution}`;
  for (const p of profile.projects || []) m[p.id] = p.title;
  for (const s of profile.skills || []) m[s.id] = `Skill: ${s.name}`;
  for (const j of profile.paidEmployment || []) m[j.id] = `${j.title}, ${j.employer}`;
  return m;
}

function Chips({ ids, labels }) {
  if (!ids?.length) return <span className="muted">No evidence cited</span>;
  return <ul className="chips">{ids.map((id) => <li key={id}><span className="chip chip-evidence" title={id}>{labels[id] || id}</span></li>)}</ul>;
}

function FitTable({ rows, labels }) {
  const counts = rows.reduce((a, r) => { const k = STATUS[r.status] ? r.status : 'unknown'; return { ...a, [k]: (a[k] || 0) + 1 }; }, {});
  return (
    <div>
      <ul className="summary-row" aria-label="Summary">
        {Object.keys(STATUS).map((k) => <li key={k}><Pill tone={STATUS[k].tone}>{STATUS[k].label}</Pill> <strong>{counts[k] || 0}</strong></li>)}
      </ul>
      <div className="table-wrap">
        <table className="fit">
          <caption className="sr-only">How your profile matches each requirement in the job post</caption>
          <thead><tr><th scope="col">Requirement in the job post</th><th scope="col">Status</th><th scope="col">What your profile shows</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`row-${r.status}`}>
                <th scope="row">{r.requirement}</th>
                <td><Pill tone={st(r.status).tone}>{st(r.status).label}</Pill></td>
                <td><p>{r.evidence || <span className="muted">Nothing in your profile addresses this yet.</span>}</p><Chips ids={r.evidenceIds} labels={labels} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Resume({ draft, labels }) {
  return (
    <div className="resume-grid">
      <article className="paper" aria-label="Resume draft"><pre>{draft.text}</pre></article>
      <div>
        {draft.flaggedUnknowns.length ? (
          <Notice tone="warn" title="Check these before you use the draft">
            <p>The coach left these out because your profile does not say. Add the facts yourself if they are true.</p>
            <ul>{draft.flaggedUnknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
          </Notice>
        ) : <Notice tone="ok" title="Nothing flagged">Every line in the draft is backed by your profile.</Notice>}
        <Disclosure summary={`Where each claim comes from (${draft.claims.length})`}>
          <ul className="claims">{draft.claims.map((c, i) => <li key={i}><p>{c.claim}</p><Chips ids={c.evidenceIds} labels={labels} /></li>)}</ul>
        </Disclosure>
      </div>
    </div>
  );
}

function Question({ q, i, instanceId, runId }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fb, setFb] = useState(null);
  const submit = async () => {
    if (busy || !answer.trim()) return;
    setBusy(true); setError(null);
    try { setFb(await post(`/instances/${instanceId}/runs/${runId}/interview-feedback`, { questionIndex: i, answer })); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const out = fb?.status === 'PASS' ? fb.output : null;
  return (
    <li className="question">
      <h4>{q.question}</h4>
      <p className="muted">Why they ask: {q.why}</p>
      <Disclosure summary="What a good answer looks like"><p>{q.whatGoodLooksLike}</p></Disclosure>
      <label htmlFor={`ans-${i}`} className="lbl">Practice your answer</label>
      <textarea id={`ans-${i}`} rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write the answer you would say out loud. Only use things that are true." />
      <Button variant="secondary" busy={busy} disabled={!answer.trim()} onClick={submit}>{fb ? 'Get feedback again' : 'Get feedback'}</Button>
      <Progress running={busy} label="Reading your answer" expect="This usually takes 10 to 20 seconds." />
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      {fb && fb.status !== 'PASS' ? <Notice tone="warn" title="No feedback this time">{(fb.reasons || []).join(' ') || 'The check on the feedback did not pass. Try again.'}</Notice> : null}
      {out ? (
        <div className="feedback">
          <p>{out.feedback}</p>
          {out.strengths.length ? <><h5>What worked</h5><ul>{out.strengths.map((s, k) => <li key={k}>{s}</li>)}</ul></> : null}
          {out.improvements.length ? <><h5>Try this next</h5><ul>{out.improvements.map((s, k) => <li key={k}>{s}</li>)}</ul></> : null}
          {out.safety?.injectionDetected ? <Notice tone="warn" title="Instructions in your answer were ignored">Your answer contained text that tried to give the coach orders. It was treated as plain text.</Notice> : null}
        </div>
      ) : null}
    </li>
  );
}

function Plan({ plan, runId }) {
  const key = `safi.plan.${runId}`;
  const [done, setDone] = useState(() => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } });
  const toggle = (id) => {
    const next = { ...done, [id]: !done[id] };
    setDone(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable: ticks last for this visit only */ }
  };
  return (
    <ol className="plan">
      {plan.map((d) => (
        <li key={d.day}>
          <h4><span className="day">Day {d.day}</span></h4>
          <ul>
            {d.actions.map((a, k) => {
              const id = `${d.day}-${k}`;
              return <li key={id}><label className="check"><input type="checkbox" checked={!!done[id]} onChange={() => toggle(id)} /> <span className={done[id] ? 'done' : ''}>{a}</span></label></li>;
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function toMarkdown(run, resumeText, labels) {
  const o = run.output;
  const L = [];
  L.push('# Job search pack', '', `Job: ${run.inputs?.job?.url || 'pasted job description'} (accessed ${run.inputs?.job?.accessDate || 'unknown date'})`, `Made by: SAFI ${run.templateRef.id} v${run.templateRef.version} (fingerprint ${shortSha(run.templateRef.sha256)}), run ${run.runId}`, '', '## How you match', '');
  L.push('| Requirement | Status | Evidence |', '| --- | --- | --- |');
  for (const r of o.matchTable) L.push(`| ${r.requirement.replace(/\|/g, '/')} | ${st(r.status).label} | ${(r.evidence || '').replace(/\|/g, '/')} ${r.evidenceIds.map((id) => `[${labels[id] || id}]`).join(' ')} |`);
  L.push('', '## Resume draft', '', resumeText.trim(), '');
  if (o.resumeDraft.flaggedUnknowns.length) L.push('Check before using:', ...o.resumeDraft.flaggedUnknowns.map((u) => `- ${u}`), '');
  L.push('## Interview questions', '');
  o.interviewQuestions.forEach((q, i) => L.push(`${i + 1}. **${q.question}**`, `   - Why they ask: ${q.why}`, `   - A good answer: ${q.whatGoodLooksLike}`));
  L.push('', '## Seven-day plan', '');
  for (const d of o.sevenDayPlan) L.push(`### Day ${d.day}`, ...d.actions.map((a) => `- [ ] ${a}`), '');
  return L.join('\n');
}

function Proof({ run, instanceId }) {
  const o = run.output;
  return (
    <Disclosure summary="Proof: how this answer was made">
      <dl className="proof">
        <dt>AI model</dt><dd className="mono">{run.model || run.requestedModel || 'unknown'}</dd>
        <dt>Provider request id</dt><dd>{run.provider?.requestId ? <CopyText value={run.provider.requestId} label="provider request id" /> : <span className="muted">none recorded</span>}</dd>
        <dt>Template</dt><dd><span className="mono">{run.templateRef.id} v{run.templateRef.version}</span> <CopyText value={run.templateRef.sha256} label="template fingerprint" short /></dd>
        <dt>Coach (instance) id</dt><dd><CopyText value={instanceId} label="instance id" /></dd>
        <dt>Run id</dt><dd><CopyText value={run.runId} label="run id" /></dd>
        <dt>Started</dt><dd>{when(run.startedAt)}{run.durationMs ? ` (took ${Math.round(run.durationMs / 1000)} s)` : ''}</dd>
        {o?.sourcesUsed?.length ? <><dt>Sources used</dt><dd>{o.sourcesUsed.join(', ')}</dd></> : null}
      </dl>
      {o?.safety?.injectionDetected ? (
        <Notice tone="warn" title="Hidden instructions were found and ignored">
          <p>The job post or resume contained text aimed at the AI. It was treated as plain text and did not change what the coach did.</p>
          {o.safety.ignoredInstructions.length ? <ul>{o.safety.ignoredInstructions.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
        </Notice>
      ) : <p className="muted">No hidden instructions were found in the pasted text.</p>}
    </Disclosure>
  );
}

export default function Results({ instanceId, runId, initialRun, profile, onChanged }) {
  const [rec, setRec] = useState(initialRun ? { run: initialRun, approval: null } : null);
  const [tab, setTab] = useState('fit');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exp, setExp] = useState(null);
  const [copied, setCopied] = useState(false);
  const labels = useMemo(() => evidenceLabels(profile), [profile]);

  useEffect(() => {
    let cancel = false;
    setExp(null); setError(null); setTab('fit');
    get(`/instances/${instanceId}/runs/${runId}`).then((r) => { if (!cancel) setRec(r); }).catch((e) => { if (!cancel) setError(e); });
    return () => { cancel = true; };
  }, [instanceId, runId]);
  useEffect(() => {
    if (!rec?.approval) return undefined;
    let cancel = false;
    get(`/instances/${instanceId}/runs/${runId}/export`).then((x) => { if (!cancel) setExp(x); }).catch((e) => { if (!cancel) setError(e); });
    return () => { cancel = true; };
  }, [rec?.approval, instanceId, runId]);

  if (!rec) return error ? <ErrorBox error={error} /> : <p role="status">Opening results...</p>;
  const { run, approval } = rec;

  if (run.status !== 'PASS') {
    return (
      <div className="results">
        <Notice tone="warn" title="The coach's answer was blocked by its safety checks, so nothing is shown.">
          <p>This is the safety net doing its job, not a crash. Before any answer reaches you, it is checked against your profile. This one failed, most often because it claimed something your profile does not support, or the AI's reply was not usable. Nothing from it was kept as an answer.</p>
          {run.task ? <p>Your request was: <em>{run.task}</em></p> : null}
          {(run.reasons || []).length ? <><p><strong>What the checks found:</strong></p><ul>{run.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></> : null}
          <p>What you can do: if the coach was asked for something untrue, add the real facts to your profile or change the request, then ask again. If it keeps happening for an ordinary request, tell your SAFI Trainer and quote run id <span className="mono">{run.runId}</span>.</p>
        </Notice>
        <Proof run={run} instanceId={instanceId} />
      </div>
    );
  }

  const o = run.output;
  const approve = async () => {
    setBusy(true); setError(null);
    try { const a = await post(`/instances/${instanceId}/runs/${runId}/approve`); setRec({ run, approval: a }); onChanged?.(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(exp.resumeText); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { window.prompt('Copy your resume draft:', exp.resumeText); }
  };
  const tabs = [
    { id: 'fit', label: 'Fit and gaps' },
    { id: 'resume', label: 'Resume draft' },
    { id: 'interview', label: 'Interview practice' },
    { id: 'plan', label: '7-day plan' }
  ];
  return (
    <div className="results">
      <header className="results-head">
        <div>
          <p className="eyebrow">Results from {when(run.startedAt)}</p>
          {run.task ? <p className="muted">You asked: <em>{run.task}</em></p> : null}
        </div>
      </header>
      {o.message ? <Notice tone="info" title="Your coach says"><p className="coach-message">{o.message}</p></Notice> : null}
      <div className="approve-bar">
        {approval ? (
          <>
            <Pill tone="ok">Approved by you, {when(approval.approvedAt)}</Pill>
            <Button variant="secondary" disabled={!exp} onClick={copy}>{copied ? 'Copied' : 'Copy resume draft'}</Button>
            <Button variant="secondary" disabled={!exp} onClick={() => download(`job-search-pack-${run.runId.slice(0, 8)}.md`, toMarkdown(run, exp.resumeText, labels))}>Download all (.md)</Button>
          </>
        ) : (
          <>
            <p>Read everything first. Copy and download unlock after you approve.</p>
            <Button busy={busy} onClick={approve}>I approve these outputs</Button>
          </>
        )}
      </div>
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Results" />
      <TabPanel id="fit" value={tab}><FitTable rows={o.matchTable} labels={labels} /></TabPanel>
      <TabPanel id="resume" value={tab}><Resume draft={o.resumeDraft} labels={labels} /></TabPanel>
      <TabPanel id="interview" value={tab}><ol className="questions">{o.interviewQuestions.map((q, i) => <Question key={`${runId}-${i}`} q={q} i={i} instanceId={instanceId} runId={runId} />)}</ol></TabPanel>
      <TabPanel id="plan" value={tab}><Plan plan={o.sevenDayPlan} runId={runId} /></TabPanel>
      <Proof run={run} instanceId={instanceId} />
    </div>
  );
}
