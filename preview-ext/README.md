# preview-ext/ — the PUBLIC PREVIEW twin of the shipped extension

**What this is:** a copy of the tabichat extension sources for preview/reading surfaces —
`src/extensions/tabichat/` stays the authority for what actually loads.

**Why it may DIFFER from the shipped copy, deliberately:** this is a dated snapshot, so after any
extension change its bytes legitimately lag (measured on a dated snapshot: `index.ts` md5s differ between the
two trees). Nobody should "fix" the md5s into agreement as a side errand — that is drift, not decay.

**What keeps the duplication honest:** `src/tools/test_broker.ts` §4a carries the
documented-duplication guard — the cells "preview twin imports its own copy", "preview twin
connects the resolved url", "preview twin has no ?? fallback" and "the two twins keep the SAME
refusal semantics". Those cells bind the SEMANTIC surface (broker resolution and refusal behavior)
on BOTH copies. So the twins may differ in comments, features and cosmetics, but they may NOT
diverge on broker-refusal semantics while the gate is green — and the gate failing there is the
named place drift shows up, exactly as the cell's own comment says.

**Do not delete this directory** without first re-pairing or removing those `test_broker.ts`
cells — the gate reads these files, so a blind deletion breaks the suite.

**node_modules is not, and never was, part of the preview.** It was tracked once as a symlink into
a foreign home path; `node_modules/` is now gitignored here, and the directory is not part of what
the release carries.
