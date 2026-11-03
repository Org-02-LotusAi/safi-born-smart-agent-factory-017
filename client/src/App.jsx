import { useCallback, useEffect, useState } from 'react';
import { get, api, post, setSignedOutHandler } from './api.js';
import { Button, ErrorBox, ErrorBoundary, Explainer, Notice } from './ui.jsx';
import Tree from './Tree.jsx';
import Use from './Use.jsx';
import Train from './Train.jsx';
import Office from './Office.jsx';

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="var(--seal-bright)" strokeWidth="3" />
      <circle cx="16" cy="16" r="2" fill="var(--seal-bright)" />
    </svg>
  );
}

function SignIn({ onDone }) {
  const [role, setRole] = useState('candidate');
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await post('/session', { role, passcode, name: name.trim() });
      onDone();
    } catch (err) { setError(err); setPasscode(''); } finally { setBusy(false); }
  };
  return (
    <main className="signin">
      <div className="signin-art" aria-hidden="true">
        <div className="lineage">
          <span className="node n0">Root rules</span>
          <span className="node n1">Career coach</span>
          <span className="node n2">CS job search coach</span>
        </div>
      </div>
      <div className="signin-card">
        <div className="brand"><Mark /> <span>SAFI Factory</span></div>
        <h1>AI agents that show their work.</h1>
        <p className="lede">Every answer here comes with the rules it followed, the evidence it used and the exact version that produced it.</p>
        <form onSubmit={submit} noValidate>
          <fieldset className="roles">
            <legend>Who is signing in?</legend>
            <label className={`role ${role === 'candidate' ? 'on' : ''}`}>
              <input type="radio" name="role" value="candidate" checked={role === 'candidate'} onChange={() => setRole('candidate')} />
              <span><strong>I'm looking for a job</strong><small>Get a coach for your job search</small></span>
            </label>
            <label className={`role ${role === 'trainer' ? 'on' : ''}`}>
              <input type="radio" name="role" value="trainer" checked={role === 'trainer'} onChange={() => setRole('trainer')} />
              <span><strong>I'm a SAFI Trainer</strong><small>Teach, test and publish agents</small></span>
            </label>
          </fieldset>
          <Notice title="How this works">
            {role === 'candidate'
              ? <p>Fill in your profile once, paste a job post, and your coach shows how you match, drafts a truthful resume, and prepares you for interviews. You approve everything before you can copy it.</p>
              : <p>Teach a correction in plain words. The AI drafts a change, every test runs on the live AI, and you decide whether to publish it. Nothing goes live without your approval.</p>}
          </Notice>
          <div className="field">
            <label htmlFor="si-name">Your name</label>
            <input id="si-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Alex Example" />
          </div>
          <div className="field">
            <label htmlFor="si-pass">Passcode</label>
            <input id="si-pass" required type="password" autoComplete="current-password" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
          </div>
          <ErrorBox error={error} />
          <Button type="submit" busy={busy} disabled={!name.trim() || !passcode}>Sign in</Button>
        </form>
      </div>
    </main>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [view, setView] = useState(() => window.location.hash.slice(1) || 'use');
  const [pendingTemplate, setPendingTemplate] = useState(null);

  const refresh = useCallback(async () => {
    try { const m = await get('/me'); setMe(m); setBootError(null); } catch (e) { setBootError(e); } finally { setLoaded(true); }
  }, []);
  useEffect(() => { setSignedOutHandler(() => setMe((m) => (m ? { ...m, authenticated: false } : m))); refresh(); }, [refresh]);
  useEffect(() => {
    const on = () => setView(window.location.hash.slice(1) || 'use');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (v, tpl) => { if (tpl) setPendingTemplate(tpl); window.location.hash = v; };

  if (!loaded) return <div className="boot" role="status">Loading SAFI Factory...</div>;
  if (bootError) return <main className="boot"><ErrorBox error={bootError} /><Button onClick={refresh}>Try again</Button></main>;
  if (!me?.authenticated) return <SignIn onDone={refresh} />;

  const trainer = me.role === 'trainer';
  const office = me.mode === 'office';
  const canTrain = trainer && !office;
  const nav = [
    { id: 'use', label: 'My coach' },
    { id: 'tree', label: 'Template tree' },
    ...(canTrain ? [{ id: 'train', label: 'Train & qualify' }, { id: 'office', label: 'Office' }] : [])
  ];
  const cur = nav.some((n) => n.id === view) ? view : 'use';
  const signOut = async () => { try { await api('DELETE', '/session'); } finally { setMe({ ...me, authenticated: false }); window.location.hash = ''; } };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="brand"><Mark /> <span>SAFI Factory</span>{office ? <span className="pill pill-neutral">Office</span> : null}</div>
        <nav aria-label="Main">
          {nav.map((n) => (
            <a key={n.id} href={`#${n.id}`} aria-current={cur === n.id ? 'page' : undefined}>{n.label}</a>
          ))}
        </nav>
        <div className="who">
          <span>{me.name} <small>{trainer ? 'SAFI Trainer' : 'Job seeker'}</small></span>
          <Button variant="quiet" onClick={signOut}>Sign out</Button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="page">
        {trainer && office ? <Notice title="Office mode">Training is done in the SAFI Factory, not in the Office. You can browse released templates and use coaches here.</Notice> : null}
        <ErrorBoundary key={cur}>
          {cur === 'tree' && <Tree me={me} go={go} />}
          {cur === 'use' && <Use me={me} initialTemplate={pendingTemplate} go={go} />}
          {cur === 'train' && <Train me={me} initialTemplate={pendingTemplate} />}
          {cur === 'office' && <Office />}
        </ErrorBoundary>
      </main>
    </>
  );
}
