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

GitHub's real merge queue is organizations-only, so this repo runs the
hand-rolled equivalent in `.github/workflows/auto-update-prs.yml`: after every
merge to `main` the workflow updates each open ready PR by **merging `main` into
it** (the update-branch API — no rebase, no force-push), which fires that PR's CI
on the true merged state. The ruleset's strict up-to-date requirement stops
auto-merge from landing a stale-green combination, and auto-merge lands the PR as
a merge commit once its updated head is green and its review threads are
resolved.

Consequences worth knowing before touching a branch:

- **Never manually rebase, merge `main` in, or "update" a branch that is merely
  behind `main`** — that chore belongs to the automation. Touch history yourself
  only to resolve a real conflict; the workflow skips conflicting branches and
  the PR shows CONFLICTING.
- The automation no longer rewrites your branch, so a plain `git pull` before
  pushing fast-forwards cleanly.
- Dependabot branches are excluded — comment `@dependabot rebase` on those.
- After any update that changes `package-lock.json`, run `npm ci` before trusting
  local gates. A stale install fails E2E in ways that look like flakes; an
  Electron bump landing mid-session produced two identical timeout failures this
  way.
- If a push seems to not trigger CI, or a PR shows a stale failing check, check
  `gh pr view <n> --json mergeable` **first** — GitHub creates no workflow runs
  for a CONFLICTING PR.
