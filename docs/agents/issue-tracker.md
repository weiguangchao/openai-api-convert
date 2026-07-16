# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment <number> --body "..."`.
- Labels: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Infer the repo from `git remote -v`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

- Map: one `wayfinder:map` issue holding destination, notes, decisions and fog.
- Child ticket: GitHub sub-issue labelled `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`.
- Blocking: native issue dependencies. If unavailable, use `Blocked by: #<n>` in the child body.
- Frontier: open, unblocked, unassigned child issues; first in map order wins.
- Claim: `gh issue edit <n> --add-assignee @me`.
- Resolve: comment with answer, close, then add a link and gist to the map's Decisions so far.
