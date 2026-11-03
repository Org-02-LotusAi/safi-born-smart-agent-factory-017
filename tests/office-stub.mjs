// Stub model for the Office tests: returns a valid job-seeker run result (copied shape from tests/server.test.mjs).
export const goodRun = () => ({
  message: "Your capstone is academic work, not paid employment. I can't submit or email anything for you; I can prepare drafts.",
  matchTable: [
    { requirement: 'Bachelor degree in Computer Science', evidence: 'B.S. Computer Science, Example State University (2026)', evidenceIds: ['edu-bs-cs'], status: 'met' },
    { requirement: 'Docker or AWS', evidence: 'Nothing in the profile', evidenceIds: [], status: 'gap' }
  ],
  resumeDraft: {
    text: 'Alex Example. B.S. Computer Science (2026). Senior capstone (academic team project): built a booking API in Python and Flask.',
    claims: [{ claim: 'Built the booking API for the capstone scheduler (academic project)', evidenceIds: ['proj-capstone-scheduler'] }],
    flaggedUnknowns: ['Docker or cloud experience is not in the profile.']
  },
  interviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i + 1}?`, why: 'Why', whatGoodLooksLike: 'An honest example' })),
  sevenDayPlan: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, actions: [`Action ${i + 1}`] })),
  safety: { injectionDetected: false, ignoredInstructions: [] },
  sourcesUsed: ['cs-job-families-and-skills']
});

export function stubLlm(counter = { n: 0 }) {
  return async (args) => {
    counter.n += 1;
    const isFeedback = /OUTPUT CONTRACT\. Reply with ONE JSON object[\s\S]*"feedback"/.test(args.instructions);
    const out = isFeedback
      ? { feedback: 'Good start.', strengths: ['Clear'], improvements: ['Add a number'], evidenceIds: ['edu-bs-cs'], safety: { injectionDetected: false, ignoredInstructions: [] } }
      : goodRun();
    return { text: JSON.stringify(out), model: 'stub-model', requestId: `req_${counter.n}`, responseId: 'resp', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, usage: null };
  };
}
