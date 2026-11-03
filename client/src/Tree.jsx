import { useEffect, useMemo, useState } from 'react';
import { get } from './api.js';
import { Button, CopyText, Disclosure, ErrorBox, Explainer, Pill } from './ui.jsx';

export const refName = (ref) => String(ref || '').split('@')[0];

function buildForest(templates) {
  const byParent = new Map();
  for (const t of templates) {
    const k = t.parentRef && templates.some((x) => x.ref === t.parentRef) ? t.parentRef : '';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(t);
  }
  return byParent;
}

function TreeNode({ t, byParent, selected, onSelect, depth, parentOf }) {
  const kids = byParent.get(t.ref) || [];
  const parent = t.parentRef ? parentOf(t.parentRef) : null;
  const sameLine = parent && parent.id === t.id;
  const tierLabel = t.status === 'DRAFT' ? 'Draft' : sameLine ? 'Next' : `T${depth}`;
  return (
    <li>
      <button className={`tnode ${selected === t.ref ? 'sel' : ''} ${t.status === 'DRAFT' ? 'draft' : ''}`} onClick={() => onSelect(t.ref)} aria-pressed={selected === t.ref}>
        <span className="tier">{tierLabel}</span>
        <span className="tnode-main">
          <strong>{t.title}</strong>
          <span className="muted mono">{t.id} v{t.version}</span>
        </span>
        <Pill tone={t.status === 'DRAFT' ? 'warn' : 'ok'}>{t.status === 'DRAFT' ? 'Draft, not published' : 'Released'}</Pill>
      </button>
      {kids.length ? (
        <ul className="tree-kids">
          {kids.map((k) => <TreeNode key={k.ref} t={k} byParent={byParent} selected={selected} onSelect={onSelect} depth={sameLineDepth(t, k, depth)} parentOf={parentOf} />)}
        </ul>
      ) : null}
    </li>
  );
}

const sameLineDepth = (t, k, depth) => (k.id === t.id ? depth : depth + 1);

export function Origin({ item }) {
  if (!item.inherited) return <Pill tone="brand">Added here</Pill>;
  return <Pill tone="neutral">Inherited from {refName(item.origin)}</Pill>;
}

function Contract({ view, tpl, hasKids, go }) {
  const c = view.contract;
  return (
    <div className="contract">
      <header className="contract-head">
        <div>
          <p className="eyebrow">{tpl.status === 'DRAFT' ? 'Draft, not yet published' : 'Released template'}</p>
          <h2>{tpl.title}</h2>
          <p className="lede">{tpl.description}</p>
        </div>
        <div className="seal" aria-label="Version and fingerprint">
          <span className="seal-v">v{tpl.version}</span>
          <CopyText value={view.sha256} label="template fingerprint" short />
          <small>Fingerprint. Copy it to cite this exact version.</small>
        </div>
      </header>
      {tpl.status === 'RELEASED' && !hasKids ? <Button onClick={() => go('use', tpl.ref)}>Start a coach from this version</Button> : null}

      <div className="lineage-line" aria-label="Lineage">
        {view.ancestry.map((a, i) => (
          <span key={a.id + a.version} className="lin"><span>{a.id}</span><small>v{a.version}</small>{i < view.ancestry.length - 1 ? <i aria-hidden="true">{'>'}</i> : null}</span>
        ))}
      </div>

      <section>
        <h3>Rules it follows <span className="count">{c.constraints.length}</span></h3>
        <ul className="rules">
          {c.constraints.map((r) => (
            <li key={r.id}>
              <p>{r.text}</p>
              <div className="meta"><Origin item={r} /> <span className="muted mono">{r.id}</span></div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>How it talks and works <span className="count">{c.roleGuidance.length}</span></h3>
        <ul className="rules">
          {c.roleGuidance.map((r, i) => (
            <li key={i}><p>{r.text}</p><div className="meta"><Origin item={r} /></div></li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Checks it must pass <span className="count">{c.tests.length}</span></h3>
        <p className="hint">A new version can only be published when every one of these passes.</p>
        <ul className="rules">
          {c.tests.map((t) => (
            <li key={t.id}>
              <p>{t.description}</p>
              <div className="meta"><Pill tone={t.kind === 'behavioral' ? 'brand' : 'neutral'}>{t.kind === 'behavioral' ? 'Tested with the live AI' : 'Structure check'}</Pill> <Origin item={t} /></div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Skills <span className="count">{c.skills.length}</span></h3>
        {c.skills.length ? <ul className="chips">{c.skills.map((s) => <li key={s.id}><span className="chip">{s.id.replace(/-/g, ' ')} <small className="mono">v{s.version}</small></span></li>)}</ul> : <p className="muted">No skills at this level.</p>}
      </section>

      <section>
        <h3>What it knows <span className="count">{c.knowledge.length}</span></h3>
        {c.knowledge.length ? (
          <ul className="rules">
            {c.knowledge.map((k) => (
              <li key={k.id}>
                <p><strong>{k.id.replace(/-/g, ' ')}</strong></p>
                <div className="meta">
                  <Origin item={k} />
                  {k.author ? <span className="muted">Published by {k.author}</span> : null}
                  {k.date ? <span className="muted">{k.date}</span> : null}
                  <CopyText value={k.sha256} label="knowledge fingerprint" short />
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted">No reference documents at this level.</p>}
      </section>

      <Disclosure summary="Tools and policies (for the technically curious)">
        <p><strong>Tools it may use:</strong> {c.tools.length ? c.tools.join(', ') : 'none'}. It has no way to send email, submit applications or browse the web.</p>
        <p><strong>Policies in force:</strong> {c.policies.join(', ')}</p>
      </Disclosure>
    </div>
  );
}

export default function Tree({ go }) {
  const [templates, setTemplates] = useState(null);
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    get('/templates').then((r) => {
      setTemplates(r.templates);
      const leaf = r.templates.find((t) => t.status === 'RELEASED' && !r.templates.some((x) => x.parentRef === t.ref));
      setSelected((leaf || r.templates[0])?.ref ?? null);
    }).catch(setError);
  }, []);
  useEffect(() => {
    if (!selected) return undefined;
    let cancel = false;
    setLoading(true); setView(null);
    get(`/templates/${encodeURIComponent(selected)}`).then((v) => { if (!cancel) setView(v); }).catch((e) => { if (!cancel) setError(e); }).finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [selected]);

  const byParent = useMemo(() => (templates ? buildForest(templates) : new Map()), [templates]);
  const roots = byParent.get('') || [];
  const tpl = templates?.find((t) => t.ref === selected);

  return (
    <div>
      <div className="page-head">
        <p className="eyebrow">Template tree</p>
        <h1>Where every agent comes from</h1>
        <p className="lede">Each template builds on the one above it. Rules are passed down, never removed. Pick one to read its contract in plain English.</p>
      </div>
      <Explainer id="tree" title="How this works">
        <p>The top template (T0) holds the rules every SAFI agent must follow. T1 adds career-coaching rules. T2 is the coach you actually use. A Trainer can teach a lesson to create a new version, which stays a draft until it passes every test and a Trainer publishes it.</p>
      </Explainer>
      <ErrorBox error={error} onDismiss={() => setError(null)} />
      {!templates ? <p role="status">Loading templates...</p> : (
        <div className="split">
          <aside aria-label="Templates">
            <ul className="tree">
              {roots.map((t) => <TreeNode key={t.ref} t={t} byParent={byParent} selected={selected} onSelect={setSelected} depth={0} parentOf={(r) => templates.find((x) => x.ref === r)} />)}
            </ul>
            {!roots.length ? <p className="muted">No templates yet.</p> : null}
          </aside>
          <section aria-live="polite" aria-label="Template contract">
            {loading ? <p role="status">Reading the contract...</p> : null}
            {view && tpl ? <Contract view={view} tpl={tpl} hasKids={templates.some((x) => x.parentRef === tpl.ref && x.id !== tpl.id)} go={go} /> : null}
          </section>
        </div>
      )}
    </div>
  );
}
