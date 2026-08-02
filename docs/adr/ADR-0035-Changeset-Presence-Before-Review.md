# ADR-0035: Changeset Presence Before Review

## Status

Accepted

## Context

ADR-0002 made changesets a convention, which allowed release-affecting pull
requests to enter review without a version record. That leaves the release
automation unable to represent every merged change.

## Decision

Every pull request adds its own semantic changeset with a `major`, `minor`, or
`patch` release entry. The draft `Changesets` workflow job validates the
changeset and confirms the entry was added by that PR, rather than inherited
from pending work on `main`.

GitHub rulesets require the stable `Changesets` context before merge. Because
GitHub has no native rule to reject a draft-to-ready transition on a status
check, the workflow immediately returns an internal PR to draft when that
transition has no passing changeset check. Full CI does not run for that failed
promotion.

The generated Version packages PR is the sole exception to PR-owned changeset
presence. It exists only after `changeset version` consumes the reviewed
changesets into package versions and the generated changelog, so its release
projection is the evidence the gate validates.

This supersedes ADR-0002's optional changeset convention.

## Consequences

- Release automation has an explicit semantic record for every pull request.
- Docs and tooling work use an appropriate patch changeset instead of an empty
  marker.
- A contributor must add the changeset before a draft can remain ready for
  review.
