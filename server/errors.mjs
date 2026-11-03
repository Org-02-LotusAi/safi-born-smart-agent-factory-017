// One JSON error shape for every failure: { error: { code, message, hint } }. Plain English, never a stack trace.
import { FactoryError } from '../factory.mjs';

export class ApiError extends Error {
  constructor(status, code, message, hint) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const STATUS_BY_CODE = {
  STALE_QUALIFICATION: 409, NOT_QUALIFIED: 409, QUALIFICATION_FAILED: 409, VERSION_EXISTS: 409, DRAFT_EXISTS: 409,
  NOT_APPROVED: 409, RUN_NOT_PASSED: 409, VERSION_CONFLICT: 409,
  MODEL_FAILED: 502, CONFIG_INVALID: 422, CONFIG_SEMANTIC: 422, PROPOSAL_REJECTED: 422
};

const HINTS = {
  CONFIG_INVALID: 'Check the highlighted fields in the profile form and try again.',
  CONFIG_SEMANTIC: 'Fix the profile details mentioned above and try again.',
  NOT_APPROVED: 'Read the drafts, then choose "I approve these" before exporting.',
  NOT_QUALIFIED: 'Run the qualification tests on this draft first.',
  STALE_QUALIFICATION: 'The draft changed after it was tested. Run the qualification tests again.',
  QUALIFICATION_FAILED: 'Fix the lesson and train again so every test passes.',
  DRAFT_EXISTS: 'Qualify and approve the existing draft, or replace it by training again with "replace" turned on.',
  PROPOSAL_REJECTED: 'Rewrite the lesson as one clear rule in plain words and try again.',
  MODEL_FAILED: 'This is usually temporary. Wait a minute and try again.',
  JOB_MISSING: 'Paste the text of a job posting and try again.',
  TRAINER_REQUIRED: 'Type the Trainer name that will be recorded on the release.'
};

/** Map a FactoryError (plain-English message already) to an ApiError; anything else returns null (caller logs, answers 500). */
export function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e instanceof FactoryError) {
    const code = e.code ?? 'FACTORY_ERROR';
    const status = STATUS_BY_CODE[code] ?? (/NOT_FOUND$/.test(code) ? 404 : 400);
    return new ApiError(status, code, e.message, HINTS[code] ?? 'Check what you entered and try again. If it keeps happening, ask the SAFI Trainer.');
  }
  return null;
}

export const errorBody = (e) => ({ error: { code: e.code, message: e.message, hint: e.hint ?? 'Try again. If it keeps happening, ask the SAFI Trainer.' } });
