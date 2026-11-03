// Dev tool: find the newest Claude model id the configured key accepts (one tiny call per candidate).
// Usage: node --env-file-if-exists=.env scripts/verify-model.mjs [model-id ...]
import { verifyModelId, MODEL_CANDIDATES } from '../lib/model.mjs';

const candidates = process.argv.slice(2);
const result = await verifyModelId(candidates.length ? candidates : MODEL_CANDIDATES);
for (const a of result.attempts) console.log(a.ok ? `OK    ${a.model} request-id=${a.requestId}` : `FAIL  ${a.model} status=${a.status} ${a.reason}`);
console.log(result.model ? `Best accepted model: ${result.model}` : 'No candidate model was accepted by this key.');
process.exitCode = result.model ? 0 : 1;
