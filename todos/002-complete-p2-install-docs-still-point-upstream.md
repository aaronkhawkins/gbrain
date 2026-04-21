---
status: complete
priority: p2
issue_id: "002"
tags: [code-review, docs, installation, fork]
dependencies: []
---

# Point Installation Docs At The Fork

The branch implements Ollama provider support on your fork, but the top-level install docs still direct users to upstream `garrytan/gbrain`. Anyone following those instructions will clone code that does not include this refactor, which means the reviewed implementation cannot actually be installed through the documented paths.

## Findings

- [README.md](/Users/akh/.codex/worktrees/0ab8/gbrain/README.md:25) tells agent users to fetch `INSTALL_FOR_AGENTS.md` from `raw.githubusercontent.com/garrytan/gbrain/master/...`.
- [README.md](/Users/akh/.codex/worktrees/0ab8/gbrain/README.md:37) tells standalone users to `git clone https://github.com/garrytan/gbrain.git`.
- [INSTALL_FOR_AGENTS.md](/Users/akh/.codex/worktrees/0ab8/gbrain/INSTALL_FOR_AGENTS.md:9) also clones `https://github.com/garrytan/gbrain.git`.
- The plan explicitly treated fork-first ownership as part of the rollout, and the implementation checklist marks docs/setup as complete, so this is a real mismatch between the documented install path and the shipped branch.

## Proposed Solutions

### Option 1: Update docs to point at the fork

**Approach:** Replace upstream clone/raw URLs with fork URLs everywhere this branch is intended to be the canonical install target.

**Pros:**
- Makes the current branch installable exactly as documented
- Small, low-risk change

**Cons:**
- Ties the docs to the fork until/unless upstream merges the feature

**Effort:** 15-30 minutes

**Risk:** Low

---

### Option 2: Add explicit fork-only callouts

**Approach:** Keep upstream URLs, but add prominent notes that the Ollama provider work exists only on the fork and requires cloning that fork/branch.

**Pros:**
- Preserves upstream references
- Lower doc churn if upstream merge is expected soon

**Cons:**
- Easier for users and agents to miss than a direct URL replacement
- Still leaves two install tracks to reason about

**Effort:** 20-40 minutes

**Risk:** Medium

## Recommended Action

Updated the documented install paths to point at the fork branch that contains the Ollama provider refactor. This keeps the docs truthful today without waiting for an upstream merge.

## Technical Details

**Affected files:**
- [README.md](/Users/akh/.codex/worktrees/0ab8/gbrain/README.md:25)
- [INSTALL_FOR_AGENTS.md](/Users/akh/.codex/worktrees/0ab8/gbrain/INSTALL_FOR_AGENTS.md:9)

## Resources

- Branch under review: `codex/ollama-embedding-provider`
- Plan: [2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md](/Users/akh/.codex/worktrees/0ab8/gbrain/docs/plans/2026-04-20-refactor-ollama-qwen3-embedding-provider-plan.md:362)

## Acceptance Criteria

- [x] All documented install paths fetch code that contains the Ollama provider refactor
- [x] Agent-install instructions no longer route users to upstream-only docs for this feature
- [x] Standalone install instructions no longer clone a repo that lacks this implementation

## Work Log

### 2026-04-20 - Review Finding

**By:** Codex

**Actions:**
- Compared the implemented branch against the completed plan checklist
- Verified the fork-first rollout goal against the actual install instructions
- Confirmed that the user-facing docs still point to upstream URLs

**Learnings:**
- The code change is on the fork, but the install path still routes users to upstream
- This is a docs/setup mismatch, not an embedding-runtime bug

### 2026-04-20 - Fix Applied

**By:** Codex

**Actions:**
- Updated [README.md](/Users/akh/.codex/worktrees/0ab8/gbrain/README.md:25) to fetch `INSTALL_FOR_AGENTS.md` from the fork branch
- Updated [README.md](/Users/akh/.codex/worktrees/0ab8/gbrain/README.md:37) standalone clone instructions to use the fork branch directly
- Updated [INSTALL_FOR_AGENTS.md](/Users/akh/.codex/worktrees/0ab8/gbrain/INSTALL_FOR_AGENTS.md:9) to clone the fork branch instead of upstream

**Learnings:**
- The safest near-term fix is branch-specific installation docs because the feature exists on the fork branch today
