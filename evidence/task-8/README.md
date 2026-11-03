# Task 8 evidence: browser rehearsal (not the real release)

These files come from an end-to-end rehearsal of DOGFOOD steps 1 to 6 in Chrome on 3 Nov 2026, against the live model (claude-sonnet-5-5).

**The rehearsal ran in a temporary COPY of the repository.** The copy published a version `safi.cs-graduate-jobseeker@1.0.1` there. That 1.0.1 is a REHEARSAL artifact. It is not the real release, it is not in this repository's `registry/index.json`, and the real 1.0.1 is published by the human Trainer in the real repository during the dogfood session (DOGFOOD.md step 5). The people were "Rehearsal Candidate" and "Rehearsal Trainer" and all data is synthetic (Alex Example).

| File | What it is |
|---|---|
| `A01_template_tree.gif` | Chrome recording: trainer sign-in, Template tree T0, T1, T2 (18 rules, "Inherited from safi.agent"). This is the recording evidence for acceptance check A01. |
| `job-search-pack-de98a485.md` | The file the app downloaded after approving a rehearsal analysis ("Download all (.md)"). |
| `safi.cs-graduate-jobseeker@1.0.1.json` | The REHEARSAL 1.0.1 template as published in the temporary copy. |
| `rehearsal-drafts/` | The draft, its lesson (meta), qualification result (21/21 PASS) and approval record from the temporary copy. |

The rehearsal write-up and the defects it found are in `.superpowers/sdd/task-8-report.md`. A scan for `sk-ant` and for the local API key found nothing in this folder before it was committed.
