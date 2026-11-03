// Canonical compiler: E(T0) = base; E(T) = R(E(parent(T)), delta T).
// Verifies the exact parent chain, applies ONLY typed additive refinements, unions inherited
// obligations, seals the parameter schema and hashes the result with RFC 8785 + SHA-256.
import { FactoryError, hashObject, canonicalJson } from './canonical.mjs';
import { loadTemplate, loadSkill, loadKnowledge, parseRef } from './registry.mjs';
import { newAjv } from './validate.mjs';
import { POLICIES, KNOWN_TOOLS, FORBIDDEN_TOOLS } from './policies.mjs';

const tag = (t) => `${t.id}@${t.version}`;
const pin = (t, sha256) => ({ id: t.id, version: t.version, sha256 });

/** Walk leaf -> root verifying versions, digests, pins, cycles and duplicate identifiers. */
export function resolveChain(id, version, opts = {}) {
  const chain = []; // leaf first
  const seenKeys = new Set();
  const seenIds = new Set();
  let cur = loadTemplate(id, version, opts);
  for (;;) {
    chain.push(cur);
    seenKeys.add(tag(cur.template));
    seenIds.add(cur.template.id);
    const parent = cur.template.parent;
    if (parent === null) return chain;
    const pkey = `${parent.id}@${parent.version}`;
    if (seenKeys.has(pkey)) {
      throw new FactoryError(
        `Template ${tag(cur.template)} has a parent loop (${pkey} appears twice in its ancestry). A template can never be its own ancestor.`,
        'CYCLE'
      );
    }
    if (seenIds.has(parent.id)) {
      throw new FactoryError(
        `Template ${tag(cur.template)} has two different versions of "${parent.id}" in its ancestry. Each template id may appear once.`,
        'DUPLICATE_ID'
      );
    }
    let next;
    try {
      next = loadTemplate(parent.id, parent.version, { ...opts, allowDraft: false });
    } catch (e) {
      if (e.code === 'TEMPLATE_NOT_FOUND') {
        throw new FactoryError(
          `Template ${tag(cur.template)} names parent ${pkey}, but that parent is missing from the registry. Add the parent release or fix the reference.`,
          'MISSING_PARENT'
        );
      }
      throw e;
    }
    if (next.sha256 !== parent.sha256) {
      throw new FactoryError(
        `Template ${tag(cur.template)} pins parent ${pkey} at sha256 ${parent.sha256.slice(0, 12)}..., but the registry parent is ${next.sha256.slice(0, 12)}.... The parent changed or the pin is wrong.`,
        'PARENT_SHA_MISMATCH'
      );
    }
    cur = next;
  }
}

function sealParameterSchema(properties, required, where) {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...required].sort()
  };
  try {
    newAjv().compile(schema);
  } catch (e) {
    throw new FactoryError(`The parameter schema in ${where} is not valid strict JSON Schema 2020-12: ${e.message}`, 'PARAMETER_SCHEMA_INVALID');
  }
  return schema;
}

function checkUnique(list, label, where) {
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item.id)) {
      throw new FactoryError(`${where} defines ${label} "${item.id}" more than once.`, 'COLLISION');
    }
    seen.add(item.id);
  }
}

function checkConstraint(c, where) {
  if (!POLICIES.includes(c.policy)) {
    throw new FactoryError(
      `Constraint "${c.id}" in ${where} names policy "${c.policy}", which is not a runtime-enforced policy. Allowed policies: ${POLICIES.join(', ')}.`,
      'UNKNOWN_POLICY'
    );
  }
}

function verifyKnowledgeRef(ref, where, opts) {
  const k = loadKnowledge(ref.id, opts);
  if (k.sha256 !== ref.sha256) {
    throw new FactoryError(`${where} pins knowledge "${ref.id}" at ${ref.sha256.slice(0, 12)}..., but the released document is ${k.sha256.slice(0, 12)}....`, 'KNOWLEDGE_PIN_MISMATCH');
  }
}

function verifySkillRef(ref, where, opts) {
  const s = loadSkill(ref.id, ref.version, opts);
  if (s.sha256 !== ref.sha256) {
    throw new FactoryError(`${where} pins skill ${ref.id}@${ref.version} at ${ref.sha256.slice(0, 12)}..., but the released skill is ${s.sha256.slice(0, 12)}....`, 'SKILL_PIN_MISMATCH');
  }
}

function baseEffective(root, sha, opts) {
  const t = root.template;
  const where = tag(t);
  const base = t.base;
  checkUnique(base.constraints, 'constraint', where);
  base.constraints.forEach((c) => checkConstraint(c, where));
  for (const p of base.policies) {
    if (!POLICIES.includes(p)) throw new FactoryError(`${where} lists policy "${p}", which is not a runtime-enforced policy.`, 'UNKNOWN_POLICY');
  }
  for (const tool of base.tools) {
    if (FORBIDDEN_TOOLS.includes(tool)) {
      throw new FactoryError(`${where} requests the forbidden tool "${tool}". Agents can never be given tools that act outward.`, 'FORBIDDEN_TOOL');
    }
    if (!KNOWN_TOOLS.includes(tool)) {
      throw new FactoryError(`${where} requests tool "${tool}", which is not an approved tool. Approved tools: ${KNOWN_TOOLS.join(', ')}.`, 'UNAPPROVED_TOOL');
    }
  }
  checkUnique(t.tests, 'test', where);
  checkUnique(t.knowledgeRefs, 'knowledge reference', where);
  checkUnique(t.skillRefs, 'skill reference', where);
  t.knowledgeRefs.forEach((r) => verifyKnowledgeRef(r, where, opts));
  t.skillRefs.forEach((r) => verifySkillRef(r, where, opts));

  const ps = t.parameterSchema;
  const props = ps.properties ?? {};
  const required = ps.required ?? [];
  for (const r of required) {
    if (!(r in props)) throw new FactoryError(`${where} requires parameter "${r}" but does not define it.`, 'PARAMETER_SCHEMA_INVALID');
  }
  const origin = where;
  return {
    constraints: base.constraints.map((c) => ({ ...c, origin })),
    tests: t.tests.map((x) => ({ ...x, origin })),
    knowledge: t.knowledgeRefs.map((k) => ({ ...k, origin })),
    skills: t.skillRefs.map((s) => ({ ...s, origin })),
    properties: { ...props },
    required: [...required],
    tools: [...base.tools].sort(),
    roleGuidance: base.roleGuidance.map((text) => ({ text, origin })),
    policies: [...base.policies]
  };
}

/** R(parent, delta): typed, additive-only. Anything else was already rejected by the meta-schema. */
function applyRefinement(state, child, opts) {
  const where = tag(child);
  const r = child.refinement;
  const next = {
    constraints: [...state.constraints],
    tests: [...state.tests],
    knowledge: [...state.knowledge],
    skills: [...state.skills],
    properties: { ...state.properties },
    required: [...state.required],
    tools: [...state.tools],
    roleGuidance: [...state.roleGuidance],
    policies: [...state.policies]
  };
  const collide = (list, id, label) => {
    if (list.some((x) => x.id === id)) {
      throw new FactoryError(`${where} adds ${label} "${id}", which an ancestor already defines. Inherited items can never be replaced or removed.`, 'COLLISION');
    }
  };
  for (const c of r.addConstraints ?? []) {
    checkConstraint(c, where);
    collide(next.constraints, c.id, 'constraint');
    next.constraints.push({ ...c, origin: where });
    if (!next.policies.includes(c.policy)) next.policies.push(c.policy);
  }
  for (const t of r.addTests ?? []) {
    collide(next.tests, t.id, 'test');
    next.tests.push({ ...t, origin: where });
  }
  for (const k of r.addKnowledgeRefs ?? []) {
    collide(next.knowledge, k.id, 'knowledge reference');
    verifyKnowledgeRef(k, where, opts);
    next.knowledge.push({ ...k, origin: where });
  }
  for (const s of r.addSkillRefs ?? []) {
    collide(next.skills, s.id, 'skill reference');
    verifySkillRef(s, where, opts);
    next.skills.push({ ...s, origin: where });
  }
  const pf = r.addParameterFields;
  if (pf) {
    for (const [name, def] of Object.entries(pf.properties ?? {})) {
      if (name in next.properties) {
        throw new FactoryError(`${where} adds parameter field "${name}", which an ancestor already defines (field collision).`, 'COLLISION');
      }
      next.properties[name] = def;
    }
    for (const name of pf.required ?? []) {
      if (!(name in next.properties)) {
        throw new FactoryError(`${where} marks parameter "${name}" as required but no template defines it.`, 'PARAMETER_SCHEMA_INVALID');
      }
      if (!next.required.includes(name)) next.required.push(name);
    }
  }
  for (const text of r.addRoleGuidance ?? []) next.roleGuidance.push({ text, origin: where });
  return next;
}

function toEffective(state, chain, upto) {
  const leaf = chain[upto];
  const where = tag(leaf.template);
  const ancestry = chain.slice(0, upto + 1).map((n) => pin(n.template, n.sha256));
  return {
    templateRef: pin(leaf.template, leaf.sha256),
    title: leaf.template.title,
    ancestry,
    constraints: state.constraints,
    tests: state.tests,
    knowledge: state.knowledge,
    skills: state.skills,
    parameterSchema: sealParameterSchema(state.properties, state.required, where),
    tools: state.tools,
    roleGuidance: state.roleGuidance,
    policies: [...state.policies].sort()
  };
}

/** Constraints(T) is a superset of Constraints(parent); Tests(T) likewise; no privilege elevation. */
export function checkInvariants(parentEff, childEff) {
  const where = `${childEff.templateRef.id}@${childEff.templateRef.version}`;
  for (const pc of parentEff.constraints) {
    const cc = childEff.constraints.find((c) => c.id === pc.id);
    if (!cc || cc.text !== pc.text || cc.policy !== pc.policy) {
      throw new FactoryError(`${where} breaks inheritance: inherited constraint "${pc.id}" is missing or changed. Inherited rules can never disappear.`, 'INVARIANT_CONSTRAINTS');
    }
  }
  for (const pt of parentEff.tests) {
    const ct = childEff.tests.find((t) => t.id === pt.id);
    if (!ct || canonicalJson(ct) !== canonicalJson(pt)) {
      throw new FactoryError(`${where} breaks inheritance: inherited test "${pt.id}" is missing or changed. Inherited tests can never disappear.`, 'INVARIANT_TESTS');
    }
  }
  for (const tool of childEff.tools) {
    if (!parentEff.tools.includes(tool)) {
      throw new FactoryError(`${where} asks for tool "${tool}" that its parent does not have. Children cannot gain tools.`, 'PRIVILEGE_ELEVATION');
    }
  }
  for (const p of parentEff.policies) {
    if (!childEff.policies.includes(p)) {
      throw new FactoryError(`${where} drops inherited policy "${p}".`, 'INVARIANT_CONSTRAINTS');
    }
  }
}

/**
 * compile("id@version", {root, allowDraft}) -> { effective, effectiveSha256, ancestry }
 * Deterministic: no clocks, no randomness; identical inputs produce an identical hash.
 */
export function compile(templateRef, opts = {}) {
  const { id, version } = parseRef(templateRef);
  const leafFirst = resolveChain(id, version, opts);
  const chain = [...leafFirst].reverse(); // root first
  let state = baseEffective(chain[0], chain[0].sha256, opts);
  let effective = toEffective(state, chain, 0);
  for (let i = 1; i < chain.length; i++) {
    state = applyRefinement(state, chain[i].template, opts);
    const next = toEffective(state, chain, i);
    checkInvariants(effective, next);
    effective = next;
  }
  return { effective, effectiveSha256: hashObject(effective), ancestry: effective.ancestry };
}

/** Deterministic structural tests, evaluated against a compiled effective definition. */
export function runStructuralTests(effective) {
  return effective.tests
    .filter((t) => t.kind === 'structural')
    .map((t) => {
      const [[op, arg]] = Object.entries(t.assert);
      const checks = {
        constraintPresent: () => effective.constraints.some((c) => c.id === arg),
        toolAbsent: () => !effective.tools.includes(arg),
        toolPresent: () => effective.tools.includes(arg),
        skillPresent: () => effective.skills.some((s) => s.id === arg),
        knowledgePresent: () => effective.knowledge.some((k) => k.id === arg),
        parameterRequired: () => effective.parameterSchema.required.includes(arg)
      };
      const pass = checks[op]();
      return { testId: t.id, origin: t.origin, kind: 'structural', status: pass ? 'PASS' : 'FAIL', evidence: { assert: t.assert } };
    });
}

