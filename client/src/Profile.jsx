import { Field } from './ui.jsx';

export const ROLE_OPTIONS = [
  { id: 'software-engineer', label: 'Software engineer' },
  { id: 'qa-engineer', label: 'QA engineer' },
  { id: 'data-analyst', label: 'Data analyst' }
];
const CONTACT_OPTIONS = [{ id: 'email', label: 'Email' }, { id: 'in-app', label: 'In this app' }, { id: 'phone', label: 'Phone' }];
const KINDS = [{ id: 'class', label: 'Class project' }, { id: 'capstone', label: 'Capstone' }, { id: 'personal', label: 'Personal project' }, { id: 'research', label: 'Research' }];

export const emptyForm = () => ({
  candidateName: '', consent: false, roles: ['software-engineer'], location: '', contact: ['email'],
  education: [{ institution: '', degree: '', field: '', endYear: '' }],
  projects: [], skillsText: '', skillsRaw: null, employment: []
});

const slug = (s, fallback) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback);
function uniqueIds(items, prefix, pick) {
  const seen = new Set();
  return items.map((it, i) => {
    let base = `${prefix}-${slug(pick(it), String(i + 1))}`;
    if (!/^[a-z]/.test(base)) base = `x-${base}`;
    let id = base; let n = 2;
    while (seen.has(id)) { id = `${base}-${n}`; n += 1; }
    seen.add(id);
    return id;
  });
}
const lines = (s) => String(s).split('\n').map((x) => x.trim()).filter(Boolean);
const commas = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

/** Turn the friendly form into the profile object the factory validates. */
export function toProfile(f) {
  const eduIds = uniqueIds(f.education, 'edu', (e) => e.institution);
  const projIds = uniqueIds(f.projects, 'proj', (p) => p.title);
  const empIds = uniqueIds(f.employment, 'job', (e) => e.employer);
  const names = commas(f.skillsText);
  const skillIds = uniqueIds(names.map((n) => ({ n })), 'skill', (x) => x.n);
  const skills = names.map((name, i) => {
    const raw = f.skillsRaw?.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const evidenceIds = raw ? raw.evidenceIds : f.projects.map((p, pi) => (commas(p.technologies).some((t) => t.toLowerCase() === name.toLowerCase()) ? projIds[pi] : null)).filter(Boolean);
    return { id: skillIds[i], name, evidenceIds };
  });
  return {
    candidateName: f.candidateName.trim(),
    consentToHostedModel: f.consent,
    preferredRoles: f.roles,
    locationPreference: f.location.trim(),
    contactPreferences: f.contact,
    education: f.education.map((e, i) => ({ id: eduIds[i], institution: e.institution.trim(), degree: e.degree.trim(), field: e.field.trim(), endYear: Number(e.endYear) })),
    projects: f.projects.map((p, i) => ({ id: projIds[i], title: p.title.trim(), kind: p.kind, description: p.description.trim(), technologies: commas(p.technologies), outcomes: lines(p.outcomes) })),
    skills,
    paidEmployment: f.employment.map((e, i) => {
      const o = { id: empIds[i], employer: e.employer.trim(), title: e.title.trim(), startYear: Number(e.startYear), description: e.description.trim() };
      if (e.endYear) o.endYear = Number(e.endYear);
      return o;
    })
  };
}

export function fromProfile(p) {
  return {
    candidateName: p.candidateName || '', consent: !!p.consentToHostedModel, roles: p.preferredRoles || [], location: p.locationPreference || '', contact: p.contactPreferences || [],
    education: (p.education || []).map((e) => ({ institution: e.institution, degree: e.degree, field: e.field, endYear: String(e.endYear) })),
    projects: (p.projects || []).map((x) => ({ title: x.title, kind: x.kind, description: x.description, technologies: (x.technologies || []).join(', '), outcomes: (x.outcomes || []).join('\n') })),
    skillsText: (p.skills || []).map((s) => s.name).join(', '), skillsRaw: p.skills || null,
    employment: (p.paidEmployment || []).map((e) => ({ employer: e.employer, title: e.title, startYear: String(e.startYear), endYear: e.endYear ? String(e.endYear) : '', description: e.description }))
  };
}

/** Light checks so the person hears about problems before the server does. Returns a list of plain sentences. */
export function formProblems(f) {
  const out = [];
  if (!f.candidateName.trim()) out.push('Add your name.');
  if (!f.consent) out.push('Tick the box to agree that your details can be sent to the AI service.');
  if (!f.roles.length) out.push('Choose at least one kind of role.');
  if (!f.location.trim()) out.push('Say where you want to work, for example "Remote".');
  if (!f.contact.length) out.push('Choose at least one way to be contacted.');
  if (!f.education.length || f.education.some((e) => !e.institution.trim() || !e.degree.trim() || !e.field.trim() || !/^\d{4}$/.test(String(e.endYear)))) out.push('Fill in each education entry, including the 4-digit year you finish or finished.');
  if (f.projects.some((p) => !p.title.trim() || !p.description.trim())) out.push('Each project needs a title and a short description.');
  if (f.employment.some((e) => !e.employer.trim() || !e.title.trim() || !/^\d{4}$/.test(String(e.startYear)) || !e.description.trim())) out.push('Each paid job needs an employer, title, start year and description. Remove the entry if you have not had a paid job.');
  return out;
}

function Check({ options, value, onChange, legend }) {
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <fieldset className="checks">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.id} className="check"><input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} /> {o.label}</label>
      ))}
    </fieldset>
  );
}

export default function ProfileForm({ value: f, onChange }) {
  const set = (patch) => onChange({ ...f, ...patch });
  const upd = (key, i, patch) => set({ [key]: f[key].map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const del = (key, i) => set({ [key]: f[key].filter((_, j) => j !== i) });
  return (
    <div className="form-grid">
      <Field label="Your name">{(a) => <input {...a} value={f.candidateName} onChange={(e) => set({ candidateName: e.target.value })} autoComplete="name" />}</Field>
      <Field label="Where do you want to work?">{(a) => <input {...a} value={f.location} onChange={(e) => set({ location: e.target.value })} placeholder="Remote, or a city" />}</Field>
      <div className="span2"><Check legend="Roles you are aiming for" options={ROLE_OPTIONS} value={f.roles} onChange={(roles) => set({ roles })} /></div>
      <div className="span2"><Check legend="How may we contact you?" options={CONTACT_OPTIONS} value={f.contact} onChange={(contact) => set({ contact })} /></div>

      <div className="span2 group">
        <h4>Education</h4>
        {f.education.map((e, i) => (
          <div className="repeat" key={i}>
            <Field label="School">{(a) => <input {...a} value={e.institution} onChange={(ev) => upd('education', i, { institution: ev.target.value })} />}</Field>
            <Field label="Degree">{(a) => <input {...a} value={e.degree} onChange={(ev) => upd('education', i, { degree: ev.target.value })} placeholder="Bachelor of Science" />}</Field>
            <Field label="Subject">{(a) => <input {...a} value={e.field} onChange={(ev) => upd('education', i, { field: ev.target.value })} placeholder="Computer Science" />}</Field>
            <Field label="Year finished (or expected)">{(a) => <input {...a} inputMode="numeric" maxLength={4} value={e.endYear} onChange={(ev) => upd('education', i, { endYear: ev.target.value })} />}</Field>
            {f.education.length > 1 ? <button type="button" className="link" onClick={() => del('education', i)}>Remove this school</button> : null}
          </div>
        ))}
        <button type="button" className="link" onClick={() => set({ education: [...f.education, { institution: '', degree: '', field: '', endYear: '' }] })}>Add another school</button>
      </div>

      <div className="span2 group">
        <h4>Projects</h4>
        <p className="hint">Class work, capstones and personal projects all count as evidence. The coach will label them honestly and never present them as paid work.</p>
        {f.projects.map((p, i) => (
          <div className="repeat" key={i}>
            <Field label="Project title">{(a) => <input {...a} value={p.title} onChange={(ev) => upd('projects', i, { title: ev.target.value })} />}</Field>
            <Field label="What kind of project was it?">{(a) => (
              <select {...a} value={p.kind} onChange={(ev) => upd('projects', i, { kind: ev.target.value })}>{KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
            )}</Field>
            <div className="span2"><Field label="What did you do?">{(a) => <textarea {...a} rows={3} value={p.description} onChange={(ev) => upd('projects', i, { description: ev.target.value })} />}</Field></div>
            <Field label="Tools used" hint="Separate with commas">{(a) => <input {...a} value={p.technologies} onChange={(ev) => upd('projects', i, { technologies: ev.target.value })} placeholder="Python, SQL, Git" />}</Field>
            <Field label="Results" hint="One per line">{(a) => <textarea {...a} rows={2} value={p.outcomes} onChange={(ev) => upd('projects', i, { outcomes: ev.target.value })} />}</Field>
            <button type="button" className="link" onClick={() => del('projects', i)}>Remove this project</button>
          </div>
        ))}
        <button type="button" className="link" onClick={() => set({ projects: [...f.projects, { title: '', kind: 'class', description: '', technologies: '', outcomes: '' }] })}>Add a project</button>
      </div>

      <div className="span2">
        <Field label="Skills" hint="Separate with commas. Skills are linked to projects that list the same tool.">{(a) => <input {...a} value={f.skillsText} onChange={(e) => set({ skillsText: e.target.value })} placeholder="Python, JavaScript, SQL" />}</Field>
      </div>

      <div className="span2 group">
        <h4>Paid jobs</h4>
        <p className="hint">Only paid work goes here. If you have not had a paid job yet, leave this empty.</p>
        {f.employment.map((e, i) => (
          <div className="repeat" key={i}>
            <Field label="Employer">{(a) => <input {...a} value={e.employer} onChange={(ev) => upd('employment', i, { employer: ev.target.value })} />}</Field>
            <Field label="Job title">{(a) => <input {...a} value={e.title} onChange={(ev) => upd('employment', i, { title: ev.target.value })} />}</Field>
            <Field label="Start year">{(a) => <input {...a} inputMode="numeric" maxLength={4} value={e.startYear} onChange={(ev) => upd('employment', i, { startYear: ev.target.value })} />}</Field>
            <Field label="End year (blank if current)">{(a) => <input {...a} inputMode="numeric" maxLength={4} value={e.endYear} onChange={(ev) => upd('employment', i, { endYear: ev.target.value })} />}</Field>
            <div className="span2"><Field label="What did you do?">{(a) => <textarea {...a} rows={2} value={e.description} onChange={(ev) => upd('employment', i, { description: ev.target.value })} />}</Field></div>
            <button type="button" className="link" onClick={() => del('employment', i)}>Remove this job</button>
          </div>
        ))}
        <button type="button" className="link" onClick={() => set({ employment: [...f.employment, { employer: '', title: '', startYear: '', endYear: '', description: '' }] })}>Add a paid job</button>
      </div>

      <label className="check consent span2">
        <input type="checkbox" checked={f.consent} onChange={(e) => set({ consent: e.target.checked })} />
        <span>I agree that my details and anything I paste in are sent to a hosted AI service to produce my results. I will not paste passwords or ID numbers.</span>
      </label>
    </div>
  );
}
