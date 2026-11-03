import { useEffect, useRef, useState } from 'react';
import { get, post, pollJob } from './api.js';
import { Button, Disclosure, ErrorBox, Explainer, Notice, Progress } from './ui.jsx';

const human = (k) => k.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Value({ v }) {
  if (v === null || v === undefined || v === '') return <span className="muted">none</span>;
  if (typeof v === 'boolean') return <span>{v ? 'Yes' : 'No'}</span>;
  if (Array.isArray(v)) return v.length ? <ul>{v.map((x, i) => <li key={i}><Value v={x} /></li>)}</ul> : <span className="muted">none</span>;
  if (typeof v === 'object') return <dl className="kv">{Object.entries(v).map(([k, x]) => (<div key={k}><dt>{human(k)}</dt><dd><Value v={x} /></dd></div>))}</dl>;
  return <span>{String(v)}</span>;
}

function Report({ title, data }) {
  return (
    <div className="report" aria-live="polite">
      <h3>{title}</h3>
      <Value v={data} />
      <Disclosure summary="Show the raw report"><pre className="raw" tabIndex={0}>{JSON.stringify(data, null, 2)}</pre></Disclosure>
    </div>
  );
}

const ACTIONS = [
  { mode: 'status', label: 'Check status', desc: 'See what is running in the Office now.', variant: 'secondary', title: 'Office status' },
  { mode: 'dry-run', label: 'Preview a deployment', desc: 'Shows what would change. Nothing is changed.', variant: 'secondary', title: 'Deployment preview' },
  { mode: 'deploy', label: 'Deploy to the Office', desc: 'Sends the published templates to the Office. Takes a few minutes.', variant: 'primary', title: 'Deployment result', long: true },
  { mode: 'restart', label: 'Restart the Office', desc: 'Restarts the Office service. People using it are interrupted briefly.', variant: 'danger', title: 'Restart result', long: true }
];

export default function Office() {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [progress, setProgress] = useState('');
  const abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async (a) => {
    if (busy) return;
    setBusy(a.mode); setError(null); setReport(null); setConfirm(null); setProgress('Starting...');
    const ac = new AbortController(); abort.current = ac;
    try {
      const r = await post('/deploy', { mode: a.mode });
      if (r && r.jobId) {
        const j = await pollJob(r.jobId, (x) => setProgress(x.progressText || ''), ac.signal);
        setReport({ title: a.title, data: j.result ?? { finished: true } });
      } else setReport({ title: a.title, data: r });
    } catch (e) { if (e.name !== 'AbortError') setError(e); } finally { setBusy(null); }
  };
  useEffect(() => { get('/deploy/status').then((d) => setReport({ title: 'Office status', data: d })).catch(() => { /* shown only on request; the buttons explain failures */ }); }, []);

  const running = ACTIONS.find((a) => a.mode === busy);
  return (
    <div>
      <div className="page-head">
        <p className="eyebrow">Office</p>
        <h1>Send published coaches to the Office</h1>
        <p className="lede">The Office is where job seekers use released coaches. Training stays here in the Factory.</p>
      </div>
      <Explainer id="office" title="How this works">
        <p>Preview first, then deploy. Deploying and restarting can take a few minutes, and only one can run at a time.</p>
      </Explainer>
      <ul className="office-actions">
        {ACTIONS.map((a) => (
          <li key={a.mode} className="panel">
            <h2>{a.label}</h2>
            <p className="muted">{a.desc}</p>
            {confirm === a.mode ? (
              <div className="actions">
                <Button variant={a.variant} busy={busy === a.mode} onClick={() => run(a)}>Yes, {a.label.toLowerCase()}</Button>
                <Button variant="quiet" onClick={() => setConfirm(null)}>Cancel</Button>
              </div>
            ) : <Button variant={a.variant} busy={busy === a.mode} disabled={!!busy} onClick={() => (a.long ? setConfirm(a.mode) : run(a))}>{a.label}</Button>}
          </li>
        ))}
      </ul>
      <Progress running={!!busy} label={running ? `${running.label} in progress` : ''} text={progress} expect="Keep this page open until it finishes." />
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      {error?.code === 'DEPLOY_NOT_INSTALLED' ? <Notice title="The Office tool is not set up yet">Deployment is added in a later step of the project. Everything else works.</Notice> : null}
      {report ? <Report title={report.title} data={report.data} /> : null}
    </div>
  );
}
