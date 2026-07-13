# Agent instructions

Before changing behavior, read the relevant docs under `docs/`.
   After changing behavior, update the relevant docs in the same change.
   If no relevant docs exist, create or update the relevant doc. 
   The docs folder directory structure follows the same directory structure as the actual project.
   Docs are to be written in HTML with links to other docs where applicable. Delegate any documentation work to the docs subagent.

Files under `docs/compute_instance/worker/pi-worker/references/pi-coding-agent/` are immutable, byte-for-byte vendored upstream references, not repository-authored docs. NEVER edit, reformat, summarize, repair, or convert them in place. Refresh only by copying from the exact `@earendil-works/pi-coding-agent` version pinned in `compute_instance/worker/pi-worker/package-lock.json` into a new versioned directory; update surrounding HTML links, provenance, and integrity tests separately.

If a workflow is precise enough to describe as a repeatable process, implement it as a script or test instead of writing a long prompt.