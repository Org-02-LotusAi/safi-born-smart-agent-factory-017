// Shared Ajv 2020 (strict) instance and plain-English error formatting.
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FactoryError } from './canonical.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function newAjv() {
  return new Ajv2020({ strict: true, allErrors: true });
}

const ajv = newAjv();
const validators = new Map();

/** Compile (and cache) one of the repo meta-schemas by file name, e.g. "template.meta.schema.json". */
export function schemaValidator(fileName) {
  let v = validators.get(fileName);
  if (!v) {
    const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'schemas', fileName), 'utf8'));
    v = ajv.compile(schema);
    validators.set(fileName, v);
  }
  return v;
}

const STRUCTURAL = new Set(['oneOf', 'if', 'then', 'else', 'anyOf', 'not']);

export function formatAjvErrors(errors) {
  const list = errors ?? [];
  const useful = list.filter((e) => !STRUCTURAL.has(e.keyword));
  return (useful.length ? useful : list)
    .map((e) => {
      const where = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'the object';
      if (e.keyword === 'additionalProperties') return `${where}: "${e.params.additionalProperty}" is not an allowed property`;
      if (e.keyword === 'required') return `${where}: missing required "${e.params.missingProperty}"`;
      if (e.keyword === 'const') return `${where}: must be exactly ${JSON.stringify(e.params.allowedValue)}`;
      if (e.keyword === 'maxItems' || e.keyword === 'maxProperties') return `${where}: must be empty here (limit ${e.params.limit})`;
      return `${where}: ${e.message}`;
    })
    .join('; ');
}

/** Validate data with a repo meta-schema; throw a FactoryError naming what is wrong. */
export function assertValid(fileName, data, label, code = 'SCHEMA_INVALID') {
  const v = schemaValidator(fileName);
  if (!v(data)) {
    throw new FactoryError(`${label} is not valid: ${formatAjvErrors(v.errors)}.`, code, v.errors);
  }
}
