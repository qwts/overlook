# CI Identity And Tokens

Which identity performs a repository write, and which token may reach which
step. `AGENTS.md` carries the one-line rule; this page carries the reasoning and
the failure modes, so the rule is followable when something breaks.

## Bot identities, not human PATs

**Anything that must start another workflow run authenticates as
`chores-dumb[bot]`** — branch and tag pushes, bot-opened PRs, and
`gh workflow run`. It is a GitHub App whose installation token is minted per run
from `CHORES_DUMB_CLIENT_ID` / `CHORES_DUMB_PRIVATE_KEY` by
`actions/create-github-app-token`. `RELEASE_TOKEN` remains only as a fallback
where the App is not installed.

A bot rather than a human PAT, for a concrete reason: a PAT opens the version PR
as `qwts`, who cannot approve their own PR, so every release cut needed a ruleset
bypass. Repository chores get a bot identity; agents get their own Apps, and the
two never share one.

## Why `GITHUB_TOKEN` is not enough

`GITHUB_TOKEN` events trigger no downstream workflows, and the repository's
Actions policy authorizes actors explicitly — `github-actions[bot]` is not one of
them, so its runs die at startup with "Actor is not allowed to trigger Actions
workflows". That is the reason a separate App identity exists at all.

## Token blast radius

Repository credentials must be **absent while third-party tools run**: checkouts
that precede them use `persist-credentials: false`, and tokens are injected only
into first-party steps containing the `git` / `gh` commands that need them.

**The PAT may reach only `actions/*` steps and our own `run:` blocks — never a
third-party action**, whose future versions nobody here controls. When a
third-party action is the only thing standing between the PAT and the run you
need, replace it or drop it. Two precedents:

- versioning is a script in `version-cut.yml` rather than `changesets/action`,
  for exactly this reason;
- the E2E-report Pages publish was deleted rather than handed the token.

## Agent identity

Each agent worktree runs as its own `<slug>[bot]` App installation, minted by the
`WorktreeCreate` hook in `.claude/settings.json`
([ENG-0016](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0016-agent-pr-bot-identity.md)).
`git` and `gh` are the only sanctioned write paths: a GitHub MCP connector
carries the human's OAuth and bypasses both, so a PR appearing as `qwts` despite
a working shim means a connector made it. Agent checkouts use **HTTPS remotes**,
because an SSH remote authenticates the push with the human's key regardless of
`GH_TOKEN`.

Commits created with `git commit` in a bot worktree cannot be Verified — the
worktree deliberately sets `commit.gpgsign=false`, since signing a bot's commit
with a human key shows Unverified. The signed-commit skill replays commits
through the Git Data API, which GitHub signs server-side.

## Merge automation

The native GitHub merge queue owns target-branch freshness. It forms a synthetic
candidate from the approved PR, current `main`, and earlier queued changes; the
`merge_group` run executes the complete suite for that exact SHA. Queue method
`MERGE` preserves that validated SHA when it reaches `main`, allowing the
main-push lane to reuse the evidence and run only the short interop smoke plus
the required default-branch CodeQL scan. A main SHA without queue evidence runs
the complete suite instead.

Consequences worth knowing before touching a branch:

- **Never manually rebase, merge `main` in, or "update" a branch that is merely
  behind `main`**. Resolve genuine conflicts on the source branch; otherwise the
  queue owns the merged candidate.
- Dependabot enters the same queue and complete-suite lifecycle after review.
- After any update that changes `package-lock.json`, run `npm ci` before trusting
  local gates. A stale install fails E2E in ways that look like flakes; an
  Electron bump landing mid-session produced two identical timeout failures this
  way.
- Queue configuration is `MERGE`, `ALLGREEN`, one concurrent candidate build,
  and one PR per merge. The ruleset retains strict status checks and resolved
  review threads.

## Workflow actor boundary

Repository Actions Policy permits only `qwts`, `chores-dumb[bot]`,
`dependabot[bot]`, and active `<agent-slug>[bot]` Apps from the governed roster.
It rejects GitHub-owned workflow actors, Copilot, third parties, retired Apps,
and public forks. The immutable playbook CI-policy action independently checks
both `github.actor` and `github.triggering_actor`; credentials do not grant actor
authorization.

## Manual repository rollout

These settings cannot be supplied by pull-request code and must be applied only
after the replacement contexts first report successfully:

1. Activate **Actions → Policies → Workflow execution protections** for
   `qwts`, `chores-dumb[bot]`, `dependabot[bot]`, and every active App in the
   governed [`agents.json`](https://github.com/qwts/playbook-engineering/blob/main/governance/agents.json).
   Permit `merge_group`; do not add `github-actions[bot]`,
   `github-merge-queue[bot]`, Copilot, external contributors, public forks, or
   retired/unregistered Apps.
2. Switch **Advanced Security → CodeQL analysis** from default to Advanced
   after a manual CI run proves both configured languages and the stable
   `CodeQL` context. Do not leave a gap in code-scanning enforcement.
3. Require `CI`, `E2E gate`, `Docs governance / docs-gov`, and `CodeQL`; retain
   the CodeQL code-scanning and code-quality rules. Remove an obsolete default
   setup context only after its Advanced replacement reports successfully.
4. Require merge queue with method `MERGE`, grouping `ALLGREEN`, one concurrent
   candidate build, and one PR per merge. Retain strict status checks, approval,
   CODEOWNERS, and resolved-thread requirements. Repository settings must keep
   merge commits enabled.

No `CHORES_DUMB` or `RELEASE_TOKEN` secret is required by the execution policy.
Those credentials remain solely for existing version/tag automation.
