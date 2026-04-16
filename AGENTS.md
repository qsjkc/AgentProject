# AgentProject Collaboration Rules

## First Pass
- Start by reading the repository structure and the nearest package or runtime config before changing code.
- Prefer understanding the existing implementation over rewriting it.
- Default to the smallest viable change that solves the task.
- Do not change business logic unless the task explicitly requires it.

## Change Discipline
- Keep changes scoped to the user request.
- Preserve current interfaces, copy, and core interaction flows unless the task explicitly asks to change them.
- For UI refactors, do not change APIs, text content, or core interaction logic by default.
- For bug fixes, prefer the highest-confidence fix over speculative refactors.
- For refactors, prioritize behavior preservation.

## Validation
- After changes, run the most relevant checks first.
- Use existing project scripts where possible instead of inventing new commands.
- For frontend work, prefer lint or build checks in `frontend/` or `desktop/`.
- For backend work, prefer targeted `pytest` runs in `backend/`.

## Output Expectations
- Summarize what changed and why.
- Call out risks, assumptions, and any validation not performed.
- Offer concise follow-up suggestions only when they are directly useful.

## Temporary Artifacts
- After a task succeeds, delete any task-generated helper scripts, scratch source files, and temporary caches unless the user explicitly asks to keep them.
- Do not create backup copies of those temporary artifacts by default.
- Apply this only to temporary artifacts created for the task, not to normal project source files, dependency caches, or runtime/business data unless the user explicitly asks to remove those too.

## Repo Notes
- Main areas are `frontend/`, `desktop/`, `backend/`, and `deploy/`.
- Prefer project-scoped Codex configuration under `.codex/` over global configuration.
