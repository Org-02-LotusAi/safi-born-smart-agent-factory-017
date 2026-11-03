import { useEffect, useState, useRef, useId } from 'react';

export function useElapsed(running) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) { setS(0); return undefined; }
    const t0 = Date.now();
    const t = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);
  return s;
}
export const fmtElapsed = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function Button({ variant = 'primary', busy, children, ...p }) {
  return (
    <button {...p} className={`btn btn-${variant} ${p.className || ''}`} disabled={p.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function ErrorBox({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      <strong>{error.message || String(error)}</strong>
      {error.hint ? <p>{error.hint}</p> : null}
      {onDismiss ? <button className="link" onClick={onDismiss}>Dismiss</button> : null}
    </div>
  );
}

export function Notice({ tone = 'info', title, children }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'warn' ? 'alert' : 'note'}>
      {title ? <strong>{title}</strong> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}

/** Progress block for long model calls: elapsed time, expectation, server progress text. */
export function Progress({ running, label, expect, text }) {
  const s = useElapsed(running);
  if (!running) return null;
  return (
    <div className="progress" role="status" aria-live="polite">
      <span className="spinner big" aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <p>{text || 'Working on it...'} <span className="mono">{fmtElapsed(s)}</span></p>
        <p className="muted">{expect}</p>
      </div>
    </div>
  );
}

export const shortSha = (s) => (s ? String(s).slice(0, 8) : '');

export function CopyText({ value, label, short }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1800); } catch { window.prompt('Copy this value:', value); }
  };
  return (
    <button type="button" className="sha" onClick={copy} title={`${label || 'Copy'}: ${value}`} aria-label={`Copy ${label || 'value'}`}>
      <span className="mono">{short ? shortSha(value) : value}</span>
      <span className="sha-tag">{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export function Pill({ tone = 'neutral', children }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Tabs({ tabs, value, onChange, label }) {
  const refs = useRef([]);
  const onKey = (e, i) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + tabs.length) % tabs.length;
    onChange(tabs[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} tabIndex={value === t.id ? 0 : -1} className="tab" onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
export const TabPanel = ({ id, value, children }) => (value === id ? <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>{children}</div> : null);

export function Field({ label, hint, children }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="hint" id={`${id}-h`}>{hint}</p> : null}
      {typeof children === 'function' ? children({ id, 'aria-describedby': hint ? `${id}-h` : undefined }) : children}
    </div>
  );
}

export function Disclosure({ summary, children, open }) {
  return (
    <details className="disclosure" open={open}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Explainer({ id, title, children }) {
  const key = `safi.explainer.${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== '1'; } catch { return true; } });
  const close = () => { setOpen(false); try { localStorage.setItem(key, '1'); } catch { /* storage unavailable */ } };
  if (!open) return <button className="link explainer-reopen" onClick={() => setOpen(true)}>How this works</button>;
  return (
    <section className="explainer" aria-label="How this works">
      <h3>{title}</h3>
      {children}
      <button className="link" onClick={close}>Got it, hide this</button>
    </section>
  );
}

export const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } };
export const today = () => new Date().toISOString().slice(0, 10);

export function download(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
