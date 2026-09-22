# Shared agent workflow

The repository is the durable source of context. Chat history is not shared.
[AGENTS.md](AGENTS.md) defines project rules; [docs/agent-tasks.md](docs/agent-tasks.md)
is the task and ownership index. `.agents/` contains supporting records.

## Claim and work

1. Read the board, relevant status/handoffs, and `git status --short`. Never reset,
   stash, commit, or overwrite another person's work as part of claiming a task.
2. Name one coordinator for the work session. The coordinator owns board edits and
   serializes claims. Request a task through `.agents/inbox/<task-id>-<agent>.md`;
   no agent begins implementation until the coordinator records its owner and file
   scope. In a single-agent session that agent may coordinate and claim its task.
3. Record a stable ID, acceptance criteria, owner, exact paths/globs, base commit,
   branch/worktree, and dependencies before implementing. Disjoint tasks can run
   together; overlapping files require a handoff or an explicit serial order.
4. Update `.agents/status/<task-id>.md` at meaningful milestones, blockers, and
   handoffs. Use UTC timestamps, exact commands/outcomes, and a concrete next action.
   The assigned owner writes this file; reviewers use separate handoff files.
5. Commit only your task's files. Hand off with a commit hash or accessible PR,
   changed paths, evidence, remaining risks, and next owner. Uncommitted files are
   visible only in their current checkout and are not a cross-worktree handoff.
6. Review acceptance criteria and the diff. The coordinator marks the board done
   after integration and verification, or records why a task remains in review.

Task states: `backlog → claimed → in-progress → review → done`.
`blocked` may occur from any active state; record the reason and resume state.
Ownership never expires automatically. The coordinator must explicitly reassign a
stale claim after checking the previous owner and preserving their work.

## Branches, worktrees, and sharing state

Use `codex/<task-id>-<slug>`, `claude/<task-id>-<slug>`, or
`fable/<task-id>-<slug>`. Prefer separate worktrees. From a clean, agreed integration
commit, this creates a new branch and sibling checkout (substitute the real ID and
verified base; do not run placeholders literally):

```sh
git worktree add ../atrium-codex-task -b codex/task-id-slug <agreed-base-commit>
```

A new worktree does not contain uncommitted changes. Do not branch from an assumed
`main`, discard existing changes, or create worktrees before agreeing which committed
state is the base. The current setup has not created branches or worktrees.

Git does not synchronize `.agents/` or the board between branches in real time.
For local concurrent work, designate one existing checkout as the **coordination
checkout** and tell every agent its absolute path at startup. Read the live board
there; the coordinator applies serialized board updates there. Agents write only
their assigned task records there, even if code is in another worktree. Commit
coordination records separately from implementation when practical.

For agents on different machines, designate a shared coordination branch or task
board. One coordinator publishes claims; workers fetch/read the latest published
state and obtain a recorded claim before editing. Publish implementation commits
and PRs through the configured remote when authorized. Stale branch copies of the
board are not evidence of an available task. These files provide a protocol, not a
scheduler, messaging service, or automatic lock.

## Records and decisions

Copy the templates in `.agents/templates/` rather than editing them in place:

- `inbox/`: requests for assignment or review; use task ID and sender in filenames.
- `status/`: one current status per task, maintained by its owner.
- `handoffs/`: immutable milestone/review notes named `<task-id>-<topic>-<author>.md`.
- `decisions/`: coordination/product decisions with proposed/accepted/superseded state.

Use existing `docs/adr/` for architecture decisions and link them from task records;
do not create competing architectural sources of truth. A proposal is not accepted
until its decision owner records acceptance. Preserve dissent and unresolved risks.

## Start a session

Tell each tool: “Read AGENTS.md and AI_WORKFLOW.md in the Atrium application repo.
The coordination checkout is <absolute-path>. Read docs/agent-tasks.md there.
Work on <task-id> within its assigned scope and leave a status/handoff.”

Point Codex and Claude Code at this repository or their assigned worktree. Explicitly
load FABLE.md for tools that do not discover it. A tool without filesystem access
needs a coordinator to transfer its notes; installing this scaffold does not connect
models or launch agents.
