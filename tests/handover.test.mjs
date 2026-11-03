// Offline tests for the handover checklist and the acceptance honesty rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pendingHumanItems } from '../scripts/handover.mjs';
import { REPO } from './helpers.mjs';

test('handover checklist lists A09, A11, the MODEL.md approval line, pending evidence and a missing v1.0.1', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'safi-handover-'));
  try {
    mkdirSync(path.join(root, 'registry'));
    writeFileSync(path.join(root, 'registry', 'index.json'), JSON.stringify([{ kind: 'template', id: 'safi.cs-graduate-jobseeker', version: '1.0.0' }]));
    writeFileSync(path.join(root, 'MODEL.md'), '- Approved by (name, role): ____________________\n');
    writeFileSync(path.join(root, 'DOGFOOD.md'), 'Status: NOT YET PERFORMED\n______\n______\n');
    writeFileSync(path.join(root, 'ACCEPTANCE.json'), JSON.stringify({ checks: [
      { id: 'A07', status: 'PARTIAL', pendingEvidence: ['human approval'] },
      { id: 'A09', status: 'BLOCKED' }, { id: 'A11', status: 'PENDING_HUMAN' }, { id: 'A02', status: 'PASS' }
    ] }));
    const items = pendingHumanItems(root).join('\n');
    assert.match(items, /A09 Office: BLOCKED/);
    assert.match(items, /A11 dogfood: PENDING_HUMAN, 2 blank fields/);
    assert.match(items, /MODEL\.md approval line is blank/);
    assert.match(items, /A07 PARTIAL: human approval/);
    assert.match(items, /v1\.0\.1 is not published/);
    assert.doesNotMatch(items, /A02/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acceptance honesty: PASS with pending evidence becomes PARTIAL; A07 and A08 always carry their human-pending lines', async () => {
  const { finalizeCheck } = await import('../scripts/acceptance.mjs');
  const plain = { id: 'A02', status: 'PASS', notes: 'ok' };
  finalizeCheck(plain);
  assert.equal(plain.status, 'PASS');
  const a01 = { id: 'A01', status: 'PASS', notes: 'x', pendingEvidence: ['recording'] };
  finalizeCheck(a01);
  assert.equal(a01.status, 'PARTIAL');
  const a07 = { id: 'A07', status: 'PASS', notes: 'old text', pendingEvidence: ['Human Trainer approval of T2 v1.0.1 in the real repository (DOGFOOD.md step 5)'] };
  finalizeCheck(a07);
  finalizeCheck(a07); // idempotent
  assert.equal(a07.status, 'PARTIAL');
  assert.equal(a07.pendingEvidence.length, 1);
  assert.match(a07.notes, /DOGFOOD step 5/);
  assert.match(a07.notes, /does not discriminate parent from child/);
  assert.equal((a07.notes.match(/does not discriminate/g) ?? []).length, 1);
  const a08 = { id: 'A08', status: 'PASS', notes: 'n' };
  finalizeCheck(a08);
  assert.equal(a08.status, 'PARTIAL');
  const failed = { id: 'A07', status: 'FAIL', notes: 'n' };
  finalizeCheck(failed);
  assert.equal(failed.status, 'FAIL');
});
