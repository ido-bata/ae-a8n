# Recovery

The state of record is GitHub, not a conversation. A session, a sandbox, or an agent can be lost;
the work does not have to be.

## Where the state lives

| Fact | Where it lives |
| --- | --- |
| What to build, and why | GitHub Issue |
| The work in progress | the ticket branch, published to the canonical remote |
| Review and validation evidence | the pull request |
| Released state | `main` |
| The current integration line | the open `release-x-y-z` branch, when one is open |
| Dependency order | the Issue's dependency links and the PR's base |
| What is still needed | the Issue and the PR, not a chat transcript |

`CLAUDE.md` is the root contract; `docs/architecture.md` describes the code. Neither is a
journal. A README, an ADR, an Issue body or a PR body is written for a reader, and it is not a
substitute for a checkpoint record.

## Resuming work

1. Find the ticket. `gh issue list --state open` for this repository.
2. Find its branch and pull request. Branches are named after the Issue number, so
   `git branch -a | grep <number>` and `gh pr list --search <number>`.
3. Read the branch head, not the conversation. `git log --oneline origin/<branch>` shows what was
   actually done; the PR shows what was validated and what was still open.
4. Re-run the validation that applies to the changed files against the **current** SHA
   (`mise run check`). A green result from an earlier SHA is not evidence for this one.
5. Continue from the recorded next step. If the PR body does not say what is next, the Issue
   does; if neither does, the branch's last commit does.

## Branches without a pull request

A ticket branch with no pull request means the work was published but never handed over. Open
the pull request before continuing — a branch alone is invisible to review.

## A pull request that is ready but not landed

Check the readiness conditions against the current SHA, then land it. Ticket-class pull requests
land on their own once the gate passes. A release pull request (`release-* → main`) is different:
it needs an explicit human authorization, and that authorization is never inferred from a
general "merge the ready PR".

## Work that was never published

A local branch with no remote counterpart is not durable. Publish it and open the pull request
before continuing, or the work is lost with the machine.

## The session workspace

The session workspace (`inbox/`, `outbox/`, `artifacts/`, `staging/`, `trace.jsonl`) is scratch
space for one AE session. It is evidence of what happened, not a place to keep work: it lives in
a temporary directory and is not committed. The trace is written per call; read it when a call
failed and the error does not explain why.
