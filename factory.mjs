#!/usr/bin/env node
// SAFI Born-Smart Agent Factory: the ONLY creation path. Library facade + CLI.
// Later tasks extend this file by (1) re-exporting new lib/ modules below and
// (2) appending entries to the `commands` table. Nothing else needs to change.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FactoryError } from './lib/canonical.mjs';
import { compile } from './lib/compiler.mjs';
import { instantiate, listInstances, getInstance } from './lib/instance.mjs';
import { loadRegistry, verifyRegistry } from './lib/registry.mjs';
import { run as runAgent, approveOutput } from './lib/runtime.mjs';

// ---- Library API (extension point: add `export * from './lib/<module>.mjs'` or named re-exports) ----
export { compile, runStructuralTests, checkInvariants, resolveChain } from './lib/compiler.mjs';
export { instantiate, getInstance, listInstances, loadOfficeGrants, intersectTools, validateConfig, semanticChecks } from './lib/instance.mjs';
export { loadRegistry, verifyRegistry, loadTemplate, loadSkill, loadKnowledge, addEntry, parseRef } from './lib/registry.mjs';
export { run, getRun, listRuns, interviewFeedback, approveOutput, exportOutput, runBehavioralTest, buildInstructions, buildInput, wrapUntrusted, detectInjection, parseModelJson, postChecks, loadJobFixture } from './lib/runtime.mjs';
export { callModel, loadLlmConfig, verifyModelId, DEFAULT_MODEL, MODEL_CANDIDATES } from './lib/model.mjs';
export { hashObject, digestOf, canonicalJson, FactoryError } from './lib/canonical.mjs';

// ---- CLI ----
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && key !== 'json') {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function readConfig(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new FactoryError(`Could not read the settings file "${file}". Check the path.`, 'FILE_MISSING');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new FactoryError(`The settings file "${file}" is not valid JSON (${e.message}).`, 'JSON_INVALID');
  }
}

// Command table: name -> { usage, run(positional, flags) -> { json, text } }.
// Later tasks append here (run, train, qualify, approve, ...).
export const commands = {
  compile: {
    usage: 'compile <id@version> [--json]',
    run([ref], flags) {
      if (!ref) throw new FactoryError('Say which template to compile, for example: node factory.mjs compile safi.agent@1.0.0', 'USAGE');
      const result = compile(ref);
      const text = [
        `Template:   ${result.effective.templateRef.id}@${result.effective.templateRef.version}`,
        `Lineage:    ${result.ancestry.map((a) => `${a.id}@${a.version}`).join(' -> ')}`,
        `Constraints ${result.effective.constraints.length}, tests ${result.effective.tests.length}, skills ${result.effective.skills.length}, knowledge ${result.effective.knowledge.length}, tools ${result.effective.tools.join(', ')}`,
        `effectiveSha256: ${result.effectiveSha256}`
      ].join('\n');
      return { json: result, text: flags.json ? undefined : text };
    }
  },
  instantiate: {
    usage: 'instantiate <id@version> <config.json> [--name "Agent name"]',
    run([ref, configFile], flags) {
      if (!ref || !configFile) throw new FactoryError('Usage: node factory.mjs instantiate <id@version> <config.json> [--name "Agent name"]', 'USAGE');
      const manifest = instantiate(ref, readConfig(configFile), { name: typeof flags.name === 'string' ? flags.name : undefined });
      return { json: manifest, text: `Created agent ${manifest.instanceId} ("${manifest.name}") from ${manifest.templateRef.id}@${manifest.templateRef.version}\neffectiveSha256: ${manifest.effectiveSha256}` };
    }
  },
  list: {
    usage: 'list',
    run() {
      const reg = loadRegistry();
      const instances = listInstances();
      const lines = reg.map((e) => `${e.kind.padEnd(9)} ${e.id}@${e.version}  ${e.sha256.slice(0, 12)}`);
      lines.push('', `Agents: ${instances.length}`, ...instances.map((m) => `  ${m.instanceId}  ${m.name}  ${m.templateRef.id}@${m.templateRef.version}`));
      return { json: { registry: reg, instances }, text: lines.join('\n') };
    }
  },
  run: {
    usage: 'run <agent-id> --job <job-file.txt> [--resume <resume.txt>] [--task "What to do"]',
    async run([instanceId], flags) {
      if (!instanceId || typeof flags.job !== 'string') throw new FactoryError('Usage: node factory.mjs run <agent-id> --job <job-file.txt> [--resume <resume.txt>] [--task "What to do"]', 'USAGE');
      const record = await runAgent(instanceId, typeof flags.task === 'string' ? flags.task : 'Compare my profile to this job posting.', {
        job: { file: flags.job },
        resumeFile: typeof flags.resume === 'string' ? flags.resume : undefined
      });
      const text = record.status === 'PASS'
        ? [`PASS run ${record.runId} (model ${record.model}, request ${record.provider.requestId})`, record.output.message].join('\n')
        : [`FAIL run ${record.runId} at step "${record.stage}":`, ...record.reasons.map((r) => `  - ${r}`)].join('\n');
      return { json: record, text, exitCode: record.status === 'PASS' ? 0 : 1 };
    }
  },
  'approve-output': {
    usage: 'approve-output <agent-id> <run-id>',
    run([instanceId, runId]) {
      if (!instanceId || !runId) throw new FactoryError('Usage: node factory.mjs approve-output <agent-id> <run-id>', 'USAGE');
      const a = approveOutput(instanceId, runId);
      return { json: a, text: a.alreadyApproved ? `Run ${runId} was already approved at ${a.approvedAt}.` : `Approved run ${runId}. The drafts can now be exported.` };
    }
  },
  verify: {
    usage: 'verify',
    run() {
      const results = verifyRegistry();
      const bad = results.filter((r) => !r.ok);
      const text = results.map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.kind} ${r.id}@${r.version}${r.ok ? '' : ` - ${r.error}`}`).join('\n');
      if (bad.length) throw new FactoryError(`${bad.length} registry entr${bad.length === 1 ? 'y failed' : 'ies failed'} verification:\n${text}`, 'VERIFY_FAILED');
      return { json: results, text: `${text}\nAll ${results.length} registry entries verified.` };
    }
  }
};

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [name, ...rest] = positional;
  const cmd = name && commands[name];
  if (!cmd) {
    const usage = Object.values(commands).map((c) => `  node factory.mjs ${c.usage}`).join('\n');
    console.error(`${name ? `Unknown command "${name}".` : 'No command given.'} Available commands:\n${usage}`);
    return 2;
  }
  try {
    const out = await cmd.run(rest, flags);
    console.log(flags.json || out.text === undefined ? JSON.stringify(out.json, null, 2) : out.text);
    return out.exitCode ?? 0;
  } catch (e) {
    if (e instanceof FactoryError) {
      console.error(`Error: ${e.message}`);
      return 1;
    }
    throw e; // unexpected: let it surface with a stack for developers
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
