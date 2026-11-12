# Dependabot watch

Status: **research, with a proposed plan** (2026-11-02). Nothing is decided. The numbered sections and summary tables
record what the primary sources say; "Fit with gitlib" is read from this repository's code and "Recommendation" is the
author's proposal, so neither is sourced the way the rest is.

**Built so far** (2026-11-02): slice 1, the report, Recommendation items 1, 2, 4 and 11 (b) and (c):
`gitlib dependabot check [--json]` (README, "Dependabot watch"), backed by `packages/core/src/dependabot/` (a pure
`classify`, a GraphQL fetch behind a `DependabotBackend` interface with a fake in the tests, and `checkDependabot`).
The verdict never reads the PR body. Choices the plan left open:

- A PR whose `statusCheckRollup` is missing or refused is **review first** with "CI unknown" and the reason, never
  ready (the Checks question in section 6 is still open, and an empty rollup is also what a repository without CI
  looks like). Failing or `UNSTABLE` is needs work; pending, a draft and `UNKNOWN` mergeability are waiting; a review
  that is required, a `security` label, extra commits, a major or unstated update type, or an unrecognised value from
  GitHub are review first.
- Not built: the "Maintainer changes" phrase and Dependabot-alert matching (both need the body or the alerts API;
  the `security` label stands in), `isRequired` per check, and the retry of `UNKNOWN` mergeability.
- Slice 2, storage (item 7 and the lease of item 6): `dependabot_runs` and `dependabot_findings` in `gitlib.db`
  (newest 60 runs), a one-row lease table taken under `BEGIN IMMEDIATE` with a 5 s busy timeout and a 15 minute expiry,
  and dismiss/snooze in `planning.db` (migration 4, since it is the user's decision). `gitlib dependabot check` saves
  by default; `show`, `dismiss` and `restore` were added. Findings of an owner that could not be asked are carried
  forward from the previous run with their original time, which is the "partial failure per PR" of "Where the
  existing scheduler falls short", point 4.
- Slice 3, the page (11 d): `/dependabot` with the buckets, reasons and suggested comments as text, snooze (a week)
  and dismiss, a "Check now" button on the same lock, a coverage footer (not checked, skipped, quota) and the NavBar
  badge (ready + review first + needs work, minus anything put aside). Text from GitHub (titles, check names) is
  drawn as plain text, links are limited to https pages on github.com, and nothing from a PR body is shown.
- Slice 4, the in-app schedule (chosen over a host-only schedule, which the Recommendation preferred): days and a
  time of day in `planning.db` (migration 5), a pure calendar function (`previousSlot`/`nextSlot`/`isCheckDue`) and
  a runner that ticks every minute inside the web server. It answers the weaknesses listed under "Where the existing
  scheduler falls short": it starts at boot (the production server calls `POST /api/dependabot/start`), is
  calendar-based, catches up from the stored runs instead of an in-memory timer, and takes the same lease as the CLI.
  The weakness that remains is the one the note names for any in-process timer: it does not run while the server or
  the machine is down. Host cron or a systemd timer calling `gitlib dependabot check` still works beside it.
- Slice 5, the prose layer (item 8): notes for needs-work and review-first PRs only, from the verdict's facts, the title
  and a markup-stripped 4,000-character slice of the description fetched on demand (never stored, never read by
  `classify`), with the rules in code and the description in a block marked as data whose closing tags the text cannot
  forge. Reply capped at 220 tokens, output cleaned (reasoning blocks, control characters, images) and shown through the
  image-free renderer under a label that the verdict did not come from it. Notes live in `dependabot_explanations`
  (`gitlib.db`) with the model name and a fingerprint of what they were written from. They run on `ModelLane`, one at a
  time, behind chat (the chat route takes the lane; a note in progress is dropped and redone). Not built: the end of a
  CI log (needs Actions: read), and a lane shared across processes. Not measured: time per note on the 3080 Ti, and no
  real model has been run, only a fake behind the same interface.
- Added to the plan: a lookup of which watched repositories the token can see, so a private repository the token
  cannot reach is reported as `NOT CHECKED` instead of looking like "no open PRs".
- 11 (a) has **not** been run: the tests use fixtures shaped like the GraphQL response in "Verify with your own
  token" command 5, written from the docs rather than captured from a real response. The first real run may show
  differences (for example how a bot's `author.login` is spelled, which the code does not depend on).

## Context

The goal is to make it easier to stay current with Dependabot pull requests across many repositories, using a
scheduled job that runs while nobody is looking at the app and reports which PRs look safe to merge and which need
work. A local LLM on the LAN (Ollama) may help write the explanations; for the Ollama API itself see
`docs/ollama-integration.md`.

Today the app reaches GitHub through `githubGet` in `apps/web/src/server/github.server.ts` (REST only, 10 s timeout,
token from `GITLIB_GITHUB_TOKEN`) and refreshes community scores with an in-process `setInterval` in
`apps/web/src/server/community.ts` (hourly check, `.unref()`ed, state on `globalThis`, 6 requests at once, a reserve
of rate-limit requests, results persisted to SQLite, timer started the first time a server function runs). This
repository's `.github/dependabot.yml` asks for weekly updates in four ecosystems (npm, github-actions, docker,
docker-compose). "Starred" means the local `repo_favorites` toggle.

Reading notes:

- Pages on docs.github.com show no version number; "read 2026-11-02" is the only date unless a page shows its own.
- **unverified** means the claim could not be confirmed at the primary source that owns it. Inferences are marked
  *(inference)*.
- No live API response was captured. The first anonymous request to `api.github.com` from this network came back
  `403` with `x-ratelimit-limit: 60`, `x-ratelimit-used: 60` and `x-ratelimit-resource: core`, so the hourly
  anonymous quota [29] was already spent and no further calls were made. Real response shapes below come from the
  docs, and from github.com pages and the `.patch` file of three Dependabot PRs in the public repository
  `dependabot/fetch-metadata` [15].
- Which REST API versions GitHub supports today was not checked (the app sends `X-GitHub-Api-Version: 2022-11-28`).

## 1. Recognising Dependabot PRs

**Author.**

- REST: `user.login` is `dependabot[bot]` and `user.type` is `Bot`. The docs' Actions recipes test
  `github.event.pull_request.user.login == 'dependabot[bot]'` [1], the schema has required `user.login` and
  `user.type` [16], and the PR list on github.com shows `dependabot[bot] (Bot)` [15].
- GraphQL: `author` is an `Actor` with `login`; the docs call an actor "typically a User or Bot" and do not say
  whether a bot login carries the `[bot]` suffix [20]. **unverified** whether GraphQL returns `dependabot` or
  `dependabot[bot]`; the first query under "Verify" prints it.
- Search: the qualifier `author:app/USERNAME` is documented for integration accounts, with a placeholder app
  named `robot` in the example, not Dependabot [33]. The query `is:pr author:app/dependabot` returned Dependabot PRs
  on github.com [15].
- Docs state that Dependabot security and version PRs are authored by the Dependabot bot account and carry the
  `dependencies` label by default [7].

**Branch name.** The default is `dependabot/PACKAGE-MANAGER/DEPENDENCY`, e.g. `dependabot/npm_and_yarn/lodash-4.17.21`
[8]. The `/` separator can be changed to `-` or `_`, `prefix` replaces `dependabot` (up to 50 characters),
`max-length` defaults to 100 (longer names are truncated and get a hash suffix), and a `template` can replace the
format [8]. Source: a multi-dependency PR without a group gets `multi-` plus the first 10 hex characters of an MD5
digest [13]. Observed: `dependabot/npm_and_yarn/undici-6.29.1` [15].

**Labels.** Every PR gets `dependencies` plus an ecosystem label (the options page gives `java` for Gradle and
`submodules` for git submodules); `major`/`minor`/`patch` labels are added if they exist; setting `labels` replaces
the defaults and `labels: []` turns all labels off [8]. Observed: `dependencies` + `javascript`, and
`dependencies` + `github_actions` [15]. A `security` label (colour `ee0701`, "Pull requests that address a security
vulnerability") is applied by `dependabot-core` when the PR includes security fixes [14]; none of the docs pages
read mention it.

**Title.** Derived from the commit message, so `commit-message.prefix` and `include: scope` change it [8].
`dependabot-core` builds "bump X from A to B" for applications, "update X requirement from A to B" for libraries and
"bump the GROUP group with N updates" for groups [12]. Observed: `build(deps): bump undici from 6.27.0 to 6.29.1`
and `build(deps-dev): bump the dev-dependencies group across 1 directory with 10 updates` [15].

**Body and commit message.** In `dependabot-core` the body is assembled as: notices, optional header, an intro line
("Bumps [name](link) from A to B", or a Package/From/To table at five or more updates), per-dependency metadata,
up to the last 20 `@dependabot ignore` conditions in a `<details>` block, and a footer [12]. The metadata presenter
file, which inserts release-note and changelog text, was not read. If a length limit is set the body ends with a
"Description has been truncated" marker [12]. Observed body (PR 767): a heading line, release notes copied from the
upstream project's releases page, a commit list, a compatibility badge, a "will resolve any conflicts" paragraph and
a "Dependabot commands and options" list [15]. Docs: the PR summary includes release notes and a changelog for you
to review [10]; security-update PRs include vulnerability information, release notes, changelog entries and commit
details [11].

**Is the format documented as stable?** No statement to that effect appears in the docs pages read [7][8][10][11].
The options page does not describe the default title format [8]. `fetch-metadata` parses titles, commit messages and
branch names with English-language regular expressions and a fixed branch layout [4].

**Security versus version updates.**

| | Security update | Version update |
|---|---|---|
| Trigger | A Dependabot alert for a dependency in the dependency graph [9] | An outdated dependency, vulnerable or not [9] |
| Target | Raises to the minimum version that contains the fix; links the PR to the alert; may show a compatibility score [9] | Manifest moves to the latest version [9] |
| Branch | Default branch only [11][8] | `target-branch` applies [8] |
| Open-PR cap | Separate fixed limit of 10; `open-pull-requests-limit` does not change it [8] | `open-pull-requests-limit`, default 5 [8] |
| Cooldown | Not subject to it [8] | Default 3-day cooldown after a release [8] |
| Grouping | Grouped per ecosystem, never with version updates [9] | `groups` in `dependabot.yml` [8] |
| On merge | The related alert is closed [9][11] | Nothing |
| Visible to | Vulnerability details hidden from anyone without access to the repository's alerts [11] | Anyone who can see the PR |

Not stated on the security page: whether the PR text carries CVE, severity or GHSA wording [9].

## 2. Is it mergeable right now?

**REST `GET /repos/{owner}/{repo}/pulls/{number}`** [16]

- On get, create or edit, GitHub makes a test merge commit (not added to either branch) to see whether the PR
  merges cleanly.
- `mergeable` is `true`, `false` or `null`. `null` means a background job has been started; wait briefly and
  request again. No polling interval or retry limit is given. When it is `true`, `merge_commit_sha` is the test
  merge commit.
- `mergeable_state` appears in the schema as a required string with no list of values. **unverified:** the values
  commonly quoted (`clean`, `dirty`, `unstable`, `blocked`, `behind`, ...) are not defined on the docs page.
- The list endpoint's response schema omits `mergeable`, `mergeable_state`, `merged`, `commits` and similar fields
  (a comparison of the two schemas, not a stated rule) [16].
- Also in the schema: `draft`, `auto_merge` (`enabled_by`, `merge_method`, ...), `labels[]`, `head.ref`, `body`
  (string or null) [16].

**GraphQL `PullRequest`** [17]

| Field | Values and meaning |
|---|---|
| `mergeable` (`MergeableState`) | `MERGEABLE`; `CONFLICTING` (cannot merge because of conflicts); `UNKNOWN` (still being calculated) |
| `mergeStateStatus` (`MergeStateStatus`) | `CLEAN` mergeable and commit status passing; `UNSTABLE` mergeable but commit status not passing; `HAS_HOOKS` mergeable, status passing, pre-receive hooks; `BEHIND` head ref out of date; `BLOCKED` merge blocked; `DIRTY` a clean merge commit cannot be created; `DRAFT` blocked because draft (**deprecated**, use `isDraft`); `UNKNOWN` cannot currently be determined |
| `reviewDecision` | `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`. When it is null is not described in the text read |
| `isDraft`, `closed`, `state` | Draft flag; open/closed/merged |
| `autoMergeRequest`, `viewerCanEnableAutoMerge`, `isInMergeQueue` | Auto-merge state and queue membership |
| `statusCheckRollup` | "Combined check and status results for the head ref" |

**Checks versus statuses.**

- A *commit status* has a `context`, a `state` (`EXPECTED`, `ERROR`, `FAILURE`, `PENDING`, `SUCCESS` in GraphQL),
  an optional description and `targetUrl` [19]. The REST combined status is `failure` if any context errors or
  fails, `pending` if there are none or any is pending, `success` if the latest of every context is `success`
  [23].
- A *check run* has `name`, `status`, `conclusion`, `title`, `summary`, `text`, `detailsUrl`, and a per-PR
  `isRequired` flag (arguments `pullRequestId` / `pullRequestNumber`) [18].
  - `CheckStatusState`: `COMPLETED`, `IN_PROGRESS`, `PENDING`, `QUEUED`, `REQUESTED`, `WAITING` [18].
  - `CheckConclusionState`: `ACTION_REQUIRED`, `CANCELLED`, `FAILURE`, `NEUTRAL`, `SKIPPED`, `STALE` (only GitHub
    sets it), `STARTUP_FAILURE`, `SUCCESS`, `TIMED_OUT` [18].
  - REST `status` values: `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`; `conclusion`:
    `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or null [22].
- `statusCheckRollup` mixes both: `contexts` are the check runs and status contexts, `state` is the combined
  `StatusState` [19].
- GitHub Actions job results are check runs, not commit statuses (inference from the REST job schema carrying a
  `check_run_url` [39]); the REST combined-status endpoint therefore does not cover them *(inference)*.

**Required checks and branch protection** [24]

- Only checks marked required gate merging; both check runs and commit statuses can be required. "Skipped" and
  "neutral" count as passing.
- "Require branches to be up to date before merging" (strict) forces a PR that is behind to be updated; without it
  a PR need not be current, and checks can pass on the branch and still fail after merge.
- A pending or "changes requested" review blocks the merge. Rulesets can do the same job as branch protection,
  several can apply at once, and only one protection rule applies per branch.
- `GET /repos/{owner}/{repo}/rules/branches/{branch}` returns the active rules that apply to a branch from every
  level (repository, organization); rulesets in "evaluate" or "disabled" mode are left out [25]. The page does not
  list the rule types returned. The permissions page lists it under Metadata (read) [35].
- A non-required check that fails still moves `mergeStateStatus` to `UNSTABLE` ("commit status is not passing")
  [17]; whether that is also true of a *non-required* failing check is not stated *(inference)*.

**Behind base and conflicts.** `BEHIND` and `DIRTY` above [17]. By default Dependabot rebases a PR when it conflicts
after a push to the target branch; it stops rebasing after extra commits are pushed to the branch or after 30 days
unmerged, and `rebase-strategy: disabled` stops it for PRs [7][8]. The skip string `[skip dependabot]` in a commit
message lets Dependabot force-push over extra commits [7].

## 3. What kind of update is it?

**`dependabot/fetch-metadata`** runs only inside a GitHub Actions workflow (examples use `pull_request` or
`pull_request_target`) [3]. Outputs are populated only if the PR was opened by Dependabot and contains only
Dependabot commits unless verification is skipped [3].

| Output | Meaning [3] |
|---|---|
| `dependency-names` | Comma-separated names |
| `dependency-type` | `direct:production`, `direct:development` or `indirect` |
| `update-type` | The highest semver change in the PR, e.g. `version-update:semver-major`; the README defers to Dependabot's `ignore` docs for the full list |
| `updated-dependencies-json` | JSON with full details per dependency; structure not described |
| `directory`, `package-ecosystem`, `target-branch` | The Dependabot configuration values |
| `previous-version`, `new-version` | From and to |
| `alert-state`, `ghsa-id`, `cvss` | `OPEN`/`FIXED`/`DISMISSED`, the GHSA ID, the CVSS value; need `alert-lookup: true` |
| `compatibility-score` | Needs `compat-lookup: true` |
| `maintainer-changes` | Whether the body contains the phrase "Maintainer changes" |
| `dependency-group` | Group name or empty |

The token defaults to `github.token`; it must be a personal access token or App token when `alert-lookup` or
`compat-lookup` is on, and `compat-lookup` needs a personal access token [3]. The complete list of `update-type`
values was not retrieved; `version-update:semver-major` is in the README and `semver-major` / `semver-patch` appear
in observed commits [3][15].

**What the API alone can give.**

- *Commit message block.* Dependabot's commit message ends with a YAML block between `---` and `...`, listing
  `dependency-name`, `dependency-version`, `dependency-type`, `update-type` and, for groups, `dependency-group`
  [15]. This is what `fetch-metadata` parses [4]. The block is reachable through `GET .../pulls/{n}/commits`
  (Pull requests: read) [35]. Observed on a direct dev-dependency group: `update-type: version-update:semver-major`
  and `...-patch` per entry [15]. Observed on two *indirect* updates: no `update-type` line at all [15]; in that case
  `fetch-metadata` computes it by comparing version segments [4]. None of the docs pages read describe this block
  as a supported format.
- *Title.* "bump X from A to B" for single-dependency PRs [12][15]; the prefix is configurable [8].
- *Branch name.* The ecosystem is the second path segment of the default layout [8][13]. `fetch-metadata` assumes
  the delimiter sits at a fixed position and that multi-dependency branches contain `and`, which breaks with a custom
  prefix or separator [4][8].
- *Labels.* `dependencies`, the ecosystem label and semver labels are applied only under the conditions in [8] and
  [14]: the semver labels need all three of `major`, `minor`, `patch` to exist in the repository and no
  `skip-release` label [14].
- *Body.* The "Bumps ... from A to B" line and the "Maintainer changes" phrase are parsed by `fetch-metadata`; the
  compatibility score is a badge image in the body and is only available as a number through `compat-lookup` [3][15].

Per-signal reliability is in the first summary table below.

## 4. Dependabot comment commands

Documented today [5]:

| Command | Effect |
|---|---|
| `@dependabot rebase` | Rebases the PR onto its base branch |
| `@dependabot recreate` | Regenerates the PR and discards manual edits |
| `@dependabot ignore this dependency` | Closes the PR and stops future PRs for that dependency |
| `@dependabot ignore this major version` / `minor` / `patch` | Closes the PR and stops future PRs for that version level |
| `@dependabot show DEPENDENCY_NAME ignore conditions` | Posts the stored ignore conditions as a comment |

Grouped version updates add `@dependabot ignore DEPENDENCY_NAME`, `... major version`, `... minor version`,
`... patch version`, `@dependabot unignore *`, `@dependabot unignore DEPENDENCY_NAME` and
`@dependabot unignore DEPENDENCY_NAME IGNORE_CONDITION` [5].

**Retired.** `@dependabot merge`, `cancel merge`, `squash and merge`, `close` and `reopen` stopped being supported on
2026-01-27; GitHub points to the web UI, `gh pr` and the REST pull request endpoints instead [6]. The commands list
in an observed PR body (PR 767) contains only rebase, recreate, show-ignore-conditions and ignore variants [15].

**Docs disagree.** The Dependabot pull requests concepts page still says commands can merge, squash, reopen, close or
rebase a PR [11]; the dated changelog and the command reference say otherwise [5][6].

Behaviour: Dependabot acknowledges a command with a thumbs-up reaction, may reply, and can take several minutes when
busy; ignore commands store preferences centrally for the repository [7]. Who may issue a command is not stated on
the pages read **(unverified)**; posting a comment is a write, so a read-only token cannot issue one.

## 5. Auto-merge

**GitHub's feature.**

- Auto-merge merges a PR after all required reviews and status checks pass [26].
- It must be allowed in the repository settings (Settings, General, Pull Requests, "Allow auto-merge"); the page
  does not name the role that can change the setting [27].
- The option appears only on PRs that cannot be merged immediately, for example because required checks or reviews
  are outstanding; on branches that require a merge queue the repository setting does not apply [26][27]. What happens
  when a branch has no required checks or reviews is not stated **(unverified)** [26][27].
- People with write permission can enable it; the author can disable it. It is switched off if someone without write
  permission pushes to the head branch or the base branch changes [26][27].
- CLI: `gh pr merge --auto` with `--merge`, `--squash` or `--rebase`; `--disable-auto`; `--match-head-commit SHA`
  allows the merge only if the head still matches [28]. On a merge-queue branch no strategy is needed [28].
- GraphQL exposes `autoMergeRequest`, `viewerCanEnableAutoMerge` and `isInMergeQueue` on a PR [17]. The mutation
  reference page was not retrieved **(unverified: mutation name and arguments)**.
- Observed: a bot in `dependabot/fetch-metadata` enabled auto-merge on a Dependabot PR on 2026-10-31 [15].

**The docs' recipe** [1]: a workflow `on: pull_request`, guarded by the PR author login being `dependabot[bot]`,
runs `dependabot/fetch-metadata` (pinned to a full commit SHA, `github-token: GITHUB_TOKEN`), then
`gh pr merge --auto --merge "$PR_URL"` with `GH_TOKEN` set, `permissions: contents: write` and
`pull-requests: write`, and a condition on `update-type` being a patch update for a named dependency. Companion
recipes label (`pull-requests: write`, `issues: write`) and auto-approve with `gh pr review --approve`. The page
advises turning on "Require status checks to pass before merging", and says that on a merge-queue branch
`GITHUB_TOKEN` cannot add a PR to the queue, so a personal access token or App token with merge permission is needed.

**Caveats the docs state.**

- Workflows started by Dependabot on `pull_request`, `pull_request_review`, `pull_request_review_comment`, `push`,
  `create`, `deployment` and `deployment_status` get a **read-only `GITHUB_TOKEN`** by default and cannot see GitHub
  Actions secrets; they receive **Dependabot secrets** instead [2].
- On `pull_request_target`, if the PR's base ref was created by Dependabot the token is read-only and secrets are
  unavailable; the restrictions still apply when a different actor re-runs the workflow [2].
- The restrictions are described as a guard against "pwn requests" [2].
- Dependabot workflows run even when Actions policies or repository/organization disablement would block other
  workflows, and the actions they reference may run [1].
- `pull_request_target` and `workflow_run` are privileged; checking out untrusted PR code in them can allow
  repository takeover [49]. Untrusted context values such as `github.event.pull_request.title` should reach scripts
  through an intermediate environment variable, not inline `${{ }}` expansion [49].
- Secret names for Dependabot secrets: letters, digits and underscores, no leading digit, no `GITHUB_` prefix [2]
  (from a search summary of the reference; the retrieved reference text did not repeat it: **unverified**).

## 6. Rate limits and querying many repositories

**REST primary limits** [29]

| Caller | Per hour |
|---|---|
| Unauthenticated, per IP | 60 |
| Authenticated user (personal access token, OAuth app on behalf of user) | 5,000 |
| GitHub App installation | 5,000 minimum, +50 per repository or org user beyond 20, capped at 12,500 |
| Enterprise Cloud organization-owned app | 15,000 |
| `GITHUB_TOKEN` in Actions | 1,000 per repository (15,000 on Enterprise Cloud) |

Headers: `x-ratelimit-limit`, `-remaining`, `-used`, `-reset` (UTC epoch seconds), `-resource`. Values can differ
between responses because requests are handled in several regions. Exceeding a limit returns `403` or `429`. Do not
retry before `x-ratelimit-reset` when remaining is 0; continuing while limited can get an integration banned [29].
`GET /rate_limit` does not count against the primary limit, but can count against the secondary one [29].

**REST secondary limits** [29]: at most 100 concurrent requests (shared with GraphQL); 900 points per minute per
REST endpoint and 2,000 per minute for GraphQL (a GET costs 1, a POST/PATCH/PUT/DELETE costs 5, some endpoints cost
more and are undisclosed); 90 s of CPU per 60 s (60 s of that for GraphQL); content-creating requests about 80 per
minute and 500 per hour. Secondary status cannot be queried and limits can change without notice. After a secondary
limit: wait `retry-after` seconds if present, else until `x-ratelimit-reset` if remaining is 0, else at least one
minute, then back off exponentially [29][30].

**Conditional requests** [30]: store `etag` / `last-modified`, send `if-none-match` / `if-modified-since`; an
unchanged resource returns `304`, and with a valid `Authorization` header a `304` does not count against the primary
limit. Parameters must match between polls, since page size, page and filter change the ETag. The rate-limit page
itself does not say whether a `304` counts [29]. GraphQL: no ETag or `304` is described [31].

**Other guidance** [30]: send requests serially rather than concurrently; leave about a second between mutating
requests; follow `Link` headers instead of building page URLs; follow redirects (`301` permanently, `302`/`307`
for that request only); prefer webhooks, and if polling use `x-poll-interval` when present. (The app's community-score
job runs 6 requests at once, within the 100-concurrent secondary cap [29].)

**GraphQL** [31]

- 5,000 points per hour for users (10,000 for Enterprise Cloud-owned apps; `GITHUB_TOKEN` 1,000 per repository).
- Cost: count the requests needed for each unique connection assuming every connection returns its `first`/`last`
  maximum, divide by 100, round to the nearest whole number, minimum 1. Every connection needs `first` or `last`
  (1 to 100); one call may not request more than 500,000 nodes in total.
- `rateLimit { limit remaining used resetAt }` and `cost` are documented fields; the page does not say whether
  querying `rateLimit` costs points.
- Requests running longer than 10 s are terminated with `502`/`504` and cost extra points for the next hour.

**Search** [32][21][33]

- REST search: 30 requests per minute authenticated (10 for code search), 10 per minute unauthenticated; at most
  1,000 results per query; `per_page` up to 100; `incomplete_results: true` after a timeout; query text capped at
  256 characters (operators and qualifiers excluded); at most five `AND`/`OR`/`NOT` operators; a `repo:`, `user:` or
  `org:` the caller cannot access gives `422` for a single resource, and inaccessible ones are silently dropped when
  several are named [32].
- GraphQL `search` returns at most 1,000 results, takes a `SearchType` (`ISSUE`, `ISSUE_ADVANCED`, `REPOSITORY`,
  `USER`, `DISCUSSION`) and cursor pagination; `issueCount` is the total match count [21]. A separate per-minute cap
  for GraphQL search is not stated on the pages read.
- Qualifiers [33]: `is:pr`, `is:open`, `author:app/NAME`, `repo:OWNER/REPO`, `user:USERNAME`, `org:ORGNAME`,
  `label:` (comma list = OR, repeated = AND), `head:BRANCH`, `base:`, `status:success|pending|failure`,
  `review:none|required|approved|changes_requested`, `draft:true|false`, `archived:false`, `-` to exclude. A search
  across more than 10,000 accessible repositories must be narrowed with an owner or repo qualifier.
- Boolean syntax [34]: in the web UI, `org:github OR user:octocat` works, limited to 16 `user`/`org` qualifiers
  combined, and parentheses nest five levels; `repo:` and `author:` are not shown with `OR`. The page does not say
  whether the REST or GraphQL search APIs accept this syntax **(unverified for the API)**.

**Cheapest documented route for N repositories.** One GraphQL `search` such as
`is:pr is:open author:app/dependabot user:OWNER archived:false` returns up to 100 PRs a page, with `mergeable`,
`mergeStateStatus`, `reviewDecision`, labels and `statusCheckRollup` nested in the same response; the 1,000-result cap
applies per query [21][17]. From the cost formula [31] a page of 50 PRs with two nested connections each is about
`1 + 50 + 50` = 101 requests, i.e. a cost of 1 *(derived; the `rateLimit { cost }` field returns the real figure)*.
By contrast the per-repository REST route is one request per repository, and `304` responses are free of primary
quota with a valid token [30]; the list-pulls parameters (and whether any filters by author) were not retrieved
**(unverified)**.

**Pagination.** REST: `per_page` (most endpoints max 100), `page` or `before`/`after` cursors, and the `Link` header
with `rel="next"`, `"prev"`, `"first"`, `"last"` (not all always present) [43]. GraphQL: `pageInfo` and cursors [21].

**Fine-grained personal access token permissions for a read-only job** [35][36]

| Need | Permission named on the permissions page | Notes |
|---|---|---|
| List / get PRs, reviews, commits, files | Pull requests: read | `GET pulls/{n}` is also listed under Contents; whether either alone is enough is not stated in the text retrieved **(unverified)** |
| Repository info, `rules/branches/{branch}` | Metadata: read | |
| Combined status, commit statuses | Commit statuses: read | Legacy statuses only [23] |
| Compare two refs | Contents: read | |
| Check runs and annotations (REST) | **Not listed** on the permissions page | The token guide lists "Using fine-grained personal access token to call the Checks API" among the things fine-grained tokens cannot do [36]; the check-runs page mentions only the classic `repo` scope for private repositories [22]. **unverified** for fine-grained tokens, in either direction; GraphQL `statusCheckRollup` access with such a token is not documented in the pages read |
| Workflow runs, jobs, job and run logs | Actions: read | Classic tokens need `repo` for private repositories [39][40] |
| Dependabot alerts (repo and org lists) | Dependabot alerts: read | The alerts page itself names classic `security_events` (`public_repo` for public only) [37] |
| `GET /search/issues` | None listed | Caller must be able to access the repositories named [32] |
| `GET /user/starred`, `GET /users/{u}/starred` | Starring: read (user permission) | |

Token scope and organisations [36]: a fine-grained token has one resource owner (a user or one organization) and
cannot span several organizations; repository access is selected, all, or public only, and every token can read all
public repositories. An organization may require approval, and until approved the token reads public resources only;
organizations that block fine-grained tokens cannot be chosen as owner; expiry is chosen at creation, with defaults
that an organization or enterprise lifetime policy can shorten. The same page lists other gaps: Packages, user-owned
Projects, writing to public repositories the user does not belong to, and repositories where the user is an outside or
repository collaborator [36]. Internal repositories are not mentioned.

## 7. Dependabot alerts

`GET /repos/{owner}/{repo}/dependabot/alerts` (also `/orgs/{org}/...` and an enterprise form; one alert at
`.../alerts/{number}`) [37].

- Filters: `state` (`auto_dismissed`, `dismissed`, `fixed`, `open`), `severity` (`low`, `medium`, `high`,
  `critical`), `ecosystem`, `package`, `manifest` (repository endpoint), `scope` (`development`, `runtime`),
  `relationship`, `epss_percentage`, `classification`, `has=patch`, `assignee`, `sort`, `direction`; pagination with
  `per_page` (max 100) and `before`/`after` cursors from the `Link` header [37].
- Permission: Dependabot alerts: read for fine-grained tokens [35]; classic `security_events` [37]. The caller needs
  access to security alerts for that repository [37]; repository admins and organization owners enable alerts and
  admins can grant access to people or teams [38]. Alerts are generated from the default branch [38]. Status codes
  listed: 200, 304, 403, 404, 422 [37].
- Fields that identify a security fix [37]:
  - `security_advisory.ghsa_id`, `cve_id`, `summary`, `description`, `severity`, `cvss_severities`, `epss`, `cwes`,
    `identifiers`, `published_at`, `withdrawn_at`
  - `security_vulnerability.package`, `severity`, `vulnerable_version_range`, `first_patched_version.identifier`
  - `dependency.package.{ecosystem,name}`, `manifest_path`, `scope`, `relationship`
  - `state`, `fixed_at`, `created_at`, `dismissed_*`
- No field in the retrieved schema names the pull request that fixes an alert. Docs say Dependabot links a
  security-update PR to its alert and that merging the PR closes the alert [9]; matching a PR to an alert from the
  API alone means comparing package, ecosystem, manifest path and the PR's new version with
  `first_patched_version` *(inference)*. `fetch-metadata` does the link in Actions (`alert-state`, `ghsa-id`, `cvss`)
  [3].
- A repository without alert access for the token returns an error status rather than an empty list is not shown
  on the page; 403 and 404 are the listed non-success codes **(behaviour unverified)** [37].

## 8. Why a PR is failing

**Check-run output** [22]: `output.title`, `output.summary`, `output.text` (each a string or null; `summary` and `text`
are capped at 65,535 characters on create), `annotations_count`, `annotations_url`. `GET
/repos/{owner}/{repo}/check-runs/{id}/annotations` returns path, line and column range, level, title, message,
`raw_details`, `blob_href`, 100 per page at most; annotation `message` and `raw_details` are capped at 64 KB each;
GitHub Actions is limited to 10 warning and 10 error annotations per step. What an Actions failure puts in `summary`
or `annotations` is not documented on the pages read **(unverified)**. `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`
returns at most the 1,000 most recent check suites for a ref [22]. In GraphQL a `CheckRun` exposes `title`, `summary`,
`text` and `detailsUrl`, the last being a link to the integrator's own site [18].

**Which job and step failed.** `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` returns per job `conclusion`,
`steps[]` (`name`, `conclusion`, `number`, `status`, timestamps), `html_url` and `check_run_url` [39]. Runs can be
filtered by `head_sha`, `branch`, `event`, `status`, `actor`; filtered searches return at most 1,000 results [40].

**Logs.**

- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` answers `302`; the log (plain text) is at the `Location`
  header and "expires after 1 minute". `302` is the only documented status. The page states no size limit [39].
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs` also answers `302` with a one-minute link, to an archive of
  the run's log files; the archive format is not stated on the page [40].
- Anyone with read access may call them; private repositories need the classic `repo` scope [39][40]; fine-grained
  tokens need Actions: read [35].
- Retention: logs and artifacts are deleted after 90 days by default; the range is 1 to 90 days for public
  repositories and 1 to 400 for private ones, and a change applies only to new logs [41].
- Redirects are normal responses: repeat the request at `Location` [30]. Whether the `Authorization` header should be
  sent to the redirect target is not stated on the pages read **(unverified)**.

**Without the Actions permission** an automation cannot list runs or jobs and cannot download logs [35][39][40]. It can
still read what the Pull requests, Commit statuses, and (subject to the unresolved Checks question in section 6)
check-run endpoints return: check names and conclusions, and whatever `summary`, `text` and annotations the check's
author wrote. CI that does not run on GitHub Actions has no log on GitHub; only `detailsUrl` / `target_url` [18][19].

## 9. Webhooks versus polling

- A webhook is a subscription: GitHub sends an HTTP request describing the event to a URL you configure, so nothing
  has to poll [44]. It can be created on a repository, organization, Marketplace account, Sponsors account or GitHub
  App, and sees only resources in that scope [44]. The "Payload URL" is "the URL where you want to receive payloads"
  (paraphrased) and a `ping` is sent after creation [47].
- The receiving server must be listening at that URL [44]. Docs do not say outright that it must be reachable from
  the internet, and do not cover localhost or private addresses [44][47]. Their local-testing advice is a relay
  (smee.io) that receives GitHub's deliveries and forwards them to the local server, which implies GitHub cannot
  deliver to it directly [48] *(inference)*.
- Delivery model: push, near real time; webhooks do not support IPv6; GitHub's source ranges come from `GET /meta`
  [44][45].
- Receiver obligations: return a 2XX within 10 seconds, otherwise the delivery is recorded as failed; acknowledge fast
  and process asynchronously; validate with a secret; GitHub does **not** redeliver failed deliveries automatically,
  you list deliveries and redeliver them through the REST API [45][46].
- GitHub's own advice: polling "scales poorly and can exhaust rate limits" [44]; prefer webhooks, and if polling,
  follow `x-poll-interval` [30].

## 10. Scheduling options

**(a) In-process timer in the web server.**

- `timeout.unref()` means an active timer no longer keeps the event loop alive; if nothing else does, the process can
  exit before the callback runs. Repeated `unref()`/`ref()` calls have no extra effect. Callbacks run "as close as
  possible" with no exact-timing guarantee; a delay above 2147483647 ms becomes 1 [50].
- The Timers page does not describe persistence; a timer is process memory, so a restart starts with none *(inference)*.
- In `community.ts` the timer is created on the first call to a server function (`ensureScheduler()` inside
  `getCommunityScores` and `refreshCommunityScores`), not at boot, and the due-check compares stored `fetchedAt`
  values in SQLite with the interval. After a restart nothing runs until a server function is called, and then the
  next tick finds whatever is overdue.
- Docker `restart: unless-stopped` restarts a container when the daemon restarts unless it was stopped; a policy
  applies only once the container has run 10 seconds [58].

**(b) Host scheduler running a CLI command.**

- *cron.* Apple: cron jobs do not run while the system is asleep or off and wait for the next scheduled time [54].
  The cronie man page does not discuss missed jobs; jumps of the clock under three hours forward run skipped jobs
  immediately, and daily/weekly/monthly jobs go through anacron [55]. Apple calls cron supported but deprecated in
  favour of launchd [54]. The repo's runbook already uses a cron entry for `scripts/backup.sh`.
- *systemd timers.* `OnCalendar=` takes calendar expressions. `Persistent=` (default off) stores the last run; if a
  run was missed while the timer was inactive, the service starts at once on activation (still subject to
  `RandomizedDelaySec=`), and it works only with `OnCalendar=`. If the system sleeps through trigger times, missed
  events are handled on resume and several missed triggers give one activation. `AccuracySec=` defaults to one minute.
  `WakeSystem=` (default off) can resume a suspended system where the hardware supports it, in the system service
  manager only [53]. Where the timestamp file lives is not stated on the page.
- *launchd.* A timed job adds a `StartCalendarInterval` dictionary (Month, Day, Weekday, Hour, Minute) to its property
  list. If the computer is asleep at the time the job runs when it wakes; if it is off the job waits for the next
  scheduled time; other launchd jobs are skipped while asleep or off. Coalescing of several missed events is not
  covered. The page is an archived document marked updated 2016-09-13 and written for OS X [54].

**(c) Compose one-off service run by an external scheduler.** A service with `profiles` starts only when the profile is
enabled, but naming it on the command line (as `docker compose run` does) starts it even if its profile is off [56].
`docker compose run` runs a one-time command in a new container with the service's configuration; `--rm` removes the
container afterwards; ports are not published unless `--service-ports` [57]. Whether `run` returns the command's exit
code is not stated on that page **(unverified)**. The scheduler is still one of (b); the repo's `gitlib` service
(`profiles: [tools]`, `restart: "no"`) already has this shape.

**(d) Scheduler sidecar container** (third-party projects, READMEs only).

- *supercronic* (aptible): a crontab-compatible runner designed for containers; waits for a job to finish before
  starting it again by default (`-overlapping` allows duplicates); `CRON_TZ=` and `TZ` supported; SIGTERM, SIGINT,
  SIGQUIT shut it down gracefully; catching up on runs missed while it was not running is not mentioned [59].
- *ofelia*: a job scheduler for Docker with `job-exec`, `job-run`, `job-local` and `job-service-run`; configured by INI
  file or Docker labels, label configuration needing access to the Docker socket; `no-overlap`; log drivers `mail`,
  `save`, `slack`; missed-run catch-up is not mentioned [60]. A fork, `netresearch/ofelia`, describes itself as based
  on the original and adds a web UI; seen in search results only, README not read [61]. Whether the original
  repository is archived was not confirmed.

**(e) GitHub Actions `on: schedule`.** Shortest interval every 5 minutes; POSIX cron syntax; runs on the latest commit
of the default branch only; delays are possible under load, especially at the start of the hour, and under very high
load some queued jobs may be dropped; in public repositories scheduled workflows are disabled automatically after 60
days without repository activity (what counts as activity is not defined) and can be re-enabled by hand or
`gh workflow enable` [62][63]. Jobs run on GitHub's infrastructure; a self-hosted runner is a machine you host and
manage (physical, virtual, container, on-premises), needs outbound HTTPS on 443 to GitHub, supports Linux, Windows and
macOS 11+, and a job with no matching online runner fails after 24 hours queued [64][65]. Whether a runner needs no
inbound connection is not stated [65].

| Option | Survives restarts | Catches up after a missed run | Runs while the laptop sleeps | Needs anything installed | Can reach a LAN Ollama |
|---|---|---|---|---|---|
| In-process timer (current pattern) | Timer: no (memory). Container comes back under `restart: unless-stopped` [58]; timer starts only on the first server-function call (code) | Only through the app's own stored timestamps (code) | No: no process runs on a suspended host *(inference)* | Nothing | Yes, same host and network as the web server |
| cron on the host | Yes, crontab is on disk [55] | Not stated by cron(8) [55]; Apple: waits for the next time [54] | No [54] | cron (macOS: supported but deprecated [54]) | Yes, if the host can |
| systemd timer (Linux) | Yes, unit files | Yes with `Persistent=true`; several misses give one run [53] | Runs on resume; `WakeSystem=` can wake the system where supported [53] | systemd | Yes, if the host can |
| launchd `StartCalendarInterval` (macOS) | Yes, plist file [54] | Runs at wake if asleep; waits for next time if off; coalescing not covered [54] | No, runs on wake [54] | Nothing (macOS) | Yes, if the Mac can |
| Compose one-off run from an external scheduler | As the outer scheduler [56][57] | As the outer scheduler | As the outer scheduler | Docker plus one of the above | Same as the web container (container networking not researched) |
| Sidecar: supercronic | Container restart policy [58]; schedule is in the crontab | Not stated [59] | No *(inference)* | Binary in the image [59] | Same as the web container |
| Sidecar: ofelia | Container restart policy [58] | Not stated [60] | No *(inference)* | Container; Docker socket for label config [60] | Same as the web container |
| GitHub Actions schedule, GitHub-hosted runner | Workflow lives in the repo; disabled after 60 inactive days in public repos [62][63] | No: delays, queued jobs may be dropped [62] | Yes, runs in GitHub's cloud | Nothing locally | No: runs on GitHub infrastructure; a LAN address is not routable from there *(inference)* |
| GitHub Actions schedule, self-hosted runner on the LAN | As above, plus the runner process | As above | Only while the runner machine is awake *(inference)* | Runner application [64] | Yes, if the runner is on the LAN *(inference)* |

## 11. A scheduled LLM job sharing a GPU with interactive chat

Read: Ollama's FAQ at docs.ollama.com [66], its error docs [67], and Go source from the Ollama repository: `main` on
2026-11-02 for `server/sched.go`, `server/routes.go`, `llm/llama_server.go` and `envconfig/config.go`, with
`sched.go` and `llama_server.go` spot-checked at tag `v0.40.13` [68][69][70][72]. The releases page shows
`v0.40.13` (28 Oct, year not shown) as the latest [73]. The source summaries were produced by reading the files
through a summarising fetch tool; line numbers are not recorded. The target machine is one RTX 3080 Ti with 12 GB
VRAM (user-supplied). General API material: `docs/ollama-integration.md`.

**Defaults and settings** [66][72]

| Setting | Default | Meaning |
|---|---|---|
| `OLLAMA_NUM_PARALLEL` | 1 | Parallel requests per loaded model; memory scales with it times `OLLAMA_CONTEXT_LENGTH` |
| `OLLAMA_MAX_LOADED_MODELS` | 0 in `envconfig`, meaning unset; FAQ: 3 per GPU (3 for CPU) | Models loaded at once if they fit; with a GPU a new model must fit entirely in VRAM to load next to others [66] |
| `OLLAMA_MAX_QUEUE` | 512 | Requests queued while busy |
| `OLLAMA_KEEP_ALIVE` | 5 minutes | How long a model stays loaded; negative = indefinitely, 0 = unload right after |
| `OLLAMA_LOAD_TIMEOUT` | 5 minutes | Stall detection for a model load; 0 or negative = infinite |
| `OLLAMA_CONTEXT_LENGTH` | 4096 (FAQ) | Context window |

A forced `numParallel` of 1 applies to embedding models and to some architectures regardless of the setting [68].

**11.1 Concurrent requests with `NUM_PARALLEL=1` and `MAX_LOADED_MODELS=1`**

- *Same model, already loaded.* The scheduler hands the loaded runner to the new request at once (it increments a
  reference count), with no wait at the scheduler [68]. A comment in the `Scheduler` type says only one model can be
  loaded at a time "but new requests to models that already loaded can happen in parallel" [68]. The wait for a free
  slot happens in `llm/llama_server.go`: `Completion` and `Chat` call `s.sem.Acquire(ctx, 1)` on a semaphore sized by
  `numParallel`, and `defer s.sem.Release(1)` releases it on every return path [70]. With `NUM_PARALLEL=1` the second
  request blocks there until the first finishes or its context ends; `Acquire` returns `ctx.Err()` if the context ends
  first [70][76].
- *Order of waiters.* The FAQ says queued requests are processed in order [66], and the scheduler reads its pending
  channel in channel order with no priority [68]. For the per-model semaphore wait, neither Ollama's docs nor the
  `x/sync/semaphore` docs state an order [66][76] **(unverified)**.
- *What `OLLAMA_MAX_QUEUE` bounds.* It sizes the scheduler's pending channel. `getRunner` pushes a request there with
  a non-blocking send only when no usable runner is loaded for the model (or it needs reload); a loaded, usable runner
  skips the channel [68]. In the files read, nothing caps the number of requests waiting on the semaphore [68][70].
- *Queue full.* The non-blocking send fails and the request gets `ErrMaxQueue` immediately [68]. `handleScheduleError`
  maps it to **HTTP 503** with a JSON body `{"error": "server busy, please try again.  maximum pending requests
  exceeded"}` (two spaces after "again."); `context.Canceled` maps to 499 `{"error":"request canceled"}`, a missing
  model to 404, bad capability requests to 400, anything else to 500 [69]. No `Retry-After` header is set in
  `sched.go` [68]. The FAQ says a full queue returns a 503 "overloaded" error [66]. **Docs differ:** the error-codes
  page lists 400, 404, 429, 500 and 502 but not 503 [67].
- *Mid-stream errors.* Once output has started, an error arrives as a final NDJSON object `{"error": ...}` (with a
  `status` key when the runner error is an `api.StatusError`) and the HTTP status stays 200 [67][69].
- *A different model is requested.* The scheduler picks a loaded runner to evict, preferring an idle one (reference
  count 0), otherwise the shortest session duration; it marks the runner to expire and re-checks about every 10 ms
  while requests are still using it; meanwhile the single pending-request loop waits for the unload to finish and
  starts no other pending request [68]. The FAQ: when a new model does not fit, requests wait in a queue, idle models
  are unloaded to make room, and queued requests are processed in order [66]. Loading is serialised [68].
- *Priority.* None in the code read; eviction chooses runners, not requests [68]. The FAQ describes no per-client
  priority or quota [66].
- *What a client sees while a model loads.* The request stays open until the model is loaded and the runner is
  available; a stalled load fails after `OLLAMA_LOAD_TIMEOUT` [72]. The docs describe no interim response; an empty
  prompt returns a "load" response after scheduling, and an empty prompt with `keep_alive: 0` unloads and returns
  `done_reason: "unload"` [69].

**11.2 `keep_alive` and eviction**

- The per-request `keep_alive` overrides `OLLAMA_KEEP_ALIVE` [66]. In the scheduler the session duration comes from
  the request if set; when the reference count reaches 0 an expiry timer starts (or the runner expires at once if the
  duration is zero or less); a request that reuses a loaded runner stops the timer and updates the duration [68].
  The FAQ does not say how requests with different values interact [66].
- `keep_alive: 0` unloads right after the response; a negative value keeps the model loaded indefinitely [66]. Eviction
  for another model sets the session duration to 0 [68], so a negative value is not documented to protect a model from
  eviction by a request for a different model **(unverified at runtime)**.

**11.3 Client abort**

- Go's `net/http` cancels the context of an incoming request when the client's connection closes (or the HTTP/2
  request is cancelled, or the handler returns) [75].
- Ollama passes `c.Request.Context()` to the scheduler and to `r.Completion` (the generation goroutine derives a
  cancellable context from it); for `stream: false` the handler reads the same channel inline and builds one JSON
  response, so both modes use the same context [69].
- Waiting for a slot: `Acquire` returns when the context ends, and a client closing the connection is logged as
  aborting [70]. A deadline error returns without that log [70].
- Streaming: the HTTP request to the runner is built with `http.NewRequestWithContext(ctx, ...)`, the response body is
  closed on return, the slot is released by the deferred `Release`, and the scan loop checks `ctx.Done()` per line; a
  blocked read ends with a read error [70]. No explicit cancel request to `llama-server` appears in the file [70].
- Whether the `llama-server` subprocess stops decoding when its connection drops is not stated by Ollama's docs [66][67]
  or by the llama.cpp server README [74] **(unverified)**; the Ollama-side slot is freed per the source.
- Queued in the scheduler: a cancelled request is skipped when dequeued; while the scheduler waits for an eviction to
  finish, the file does not show the request's context being re-checked [68].

**11.4 What the calling app cannot control.** Other clients on the LAN sending requests, the models they load, their
`keep_alive` values, context sizes and how many requests they send at once. The FAQ mentions no built-in
authentication or per-client controls and shows nginx, ngrok and Cloudflare Tunnel in front of Ollama for exposure
[66]. The server-side settings are therefore the only backstop: `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_QUEUE`,
`OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE` (the default for requests that omit it), `OLLAMA_CONTEXT_LENGTH`,
`OLLAMA_LOAD_TIMEOUT`, and `OLLAMA_HOST` for the bind address (default `127.0.0.1:11434`) [66][72]. `ollama ps` lists
loaded models and whether they sit on GPU or CPU [66]; for the HTTP equivalent see `docs/ollama-integration.md`.

**11.5 Cross-process coordination (web server and a separate scheduled CLI).**

- `BEGIN IMMEDIATE` starts a write transaction right away instead of at the first write; it fails with `SQLITE_BUSY`
  if another connection already holds a write transaction. Many connections can hold read transactions, one holds the
  write transaction. A read transaction upgraded to write can fail with `SQLITE_BUSY`; `COMMIT` can return
  `SQLITE_BUSY` while other connections hold read transactions (the transaction stays open and can be retried);
  `BEGIN` cannot be nested [77]. The page does not say whether others can still read during an `IMMEDIATE`
  transaction outside WAL mode. In rollback-journal mode one RESERVED lock can coexist with SHARED locks (readers
  continue while a writer prepares), and an EXCLUSIVE lock, needed to write the file, coexists with nothing [80]. The
  locking page does not mention `BEGIN IMMEDIATE` **(mapping unverified)**.
- WAL: readers and the single writer do not block each other; only one writer at a time; all processes must be on the
  same host (no network filesystem) because of the shared-memory index; WAL mode is stored in the database file and
  persists; automatic checkpoint at about 1000 pages; `SQLITE_BUSY` can still occur (exclusive locking mode, last
  connection closing, recovery after a crash) [78]. The WAL page also describes a rare WAL-reset data race in versions
  3.7.0 to 3.51.2, fixed in 3.51.3 (2026-03-13) with backports to 3.44.6 and 3.50.7 [78]. Which SQLite version
  Node 24 embeds was not checked. Whether Docker Desktop bind mounts count as "same host" is not covered by the SQLite
  docs **(unverified)**.
- Busy timeout: `sqlite3_busy_timeout(ms)` makes SQLite sleep and retry until at least `ms` have accumulated, then
  return `SQLITE_BUSY`; `ms <= 0` turns the handler off; one handler per connection; the SQL form is
  `PRAGMA busy_timeout` [79]. The deadlock exception (a busy handler not being invoked) is not on that page
  **(unverified)**.
- Node: `new DatabaseSync(path, options)` takes `timeout` (busy timeout in ms, default `0`, added in v24.0.0),
  `readOnly`, `open`; `database.isTransaction` reports an open transaction; the page does not document WAL or
  `BEGIN IMMEDIATE` in the part read (the last 2 KB were not read); the module is "Stability: 1.2, release candidate"
  in the v24.x docs [51]. The latest docs (v26.13.0) name the class `Database` and list `DatabaseSync` as a deprecated
  alias (DEP0210) [52].
- In this repo: `Store.withConnection` (`packages/core/src/store.ts`) opens `new DatabaseSync(this.dbPath)` with no
  `timeout` and uses plain `BEGIN`; the planning store (`packages/core/src/planning/store.ts`) uses
  `timeout: 5_000` and `BEGIN IMMEDIATE`; no `journal_mode` pragma was found under `packages/core/src` or
  `apps/*/src`. In `docker-compose.yml` the `web` and `gitlib` (tools) services mount the same named volume
  `gitlib-data:/data`.

## 12. Risk model for unattended runs

OWASP Top 10 for LLM Applications, 2025 edition [81]. Situation: the model reads a PR body that quotes release notes and
commit messages written by whoever publishes the package [12][15], and its output may influence a merge decision.

- **LLM01 Prompt Injection.** Indirect injection arrives through external content the model processes and can distort
  decisions, including text invisible to human readers [82]; release-note text in the PR body is such content.
- **LLM02 Sensitive Information Disclosure.** Data placed in the prompt (private-repository PR text, tokens in logs) can
  reappear in output, and restrictions in the system prompt alone can be bypassed through injection [83].
- **LLM03 Supply Chain.** Covers third-party models, adapters, datasets and vulnerable components [84]; the Ollama model
  files and the packages Dependabot proposes are both inputs of that kind.
- **LLM05 Improper Output Handling.** Model output passed to other systems without validation can lead to XSS, CSRF,
  SSRF, privilege escalation or code execution [85]; the report text goes to a web page and possibly to ntfy, Slack or
  email.
- **LLM06 Excessive Agency.** Damaging actions follow from ambiguous or manipulated output when a system has too many
  functions, permissions or autonomy; the mitigations named are narrow permissions, human approval for high-impact
  actions and authorization enforced downstream rather than by the model [86].
- **LLM09 Misinformation.** Plausible but false statements (for example "no breaking changes") come from hallucination;
  the mitigations named are grounding in verified data and human review of high-stakes output [87].
- **LLM10 Unbounded Consumption.** Floods of inputs, context overflow and heavy queries exhaust resources; the
  mitigations named are input-size validation, rate limits, timeouts and per-request caps [88]; many PRs with long
  bodies on a shared GPU is that case.
- LLM04 (data and model poisoning), LLM07 (system prompt leakage) and LLM08 (vector and embedding weaknesses) concern
  training data, hidden prompts and retrieval stores [81]; they apply to this job only if it adds those pieces.

**What GitHub's docs say the PR body is and is not.**

- *Is:* a summary with release notes and a changelog for the maintainer to review before merging [10]; for security
  updates also vulnerability information, release notes, changelog entries and commit details, hidden from people
  without access to the repository's alerts [11]. The docs recommend tests and acceptance checks before merging [11].
- *Is not:* none of the pages read call the body trusted, sanitised or verified. `dependabot-core` imports a link and
  mention sanitizer in the message builder but does not call it in that file; the presenter that inserts upstream text
  was not read [12]. `fetch-metadata` populates outputs only when the PR was opened by Dependabot and has only
  Dependabot commits [3], and Dependabot signs its own commits by default [9]; that establishes who made the commit,
  not that the quoted upstream text is safe.
- Workflow authors are told to treat values such as the PR title as untrusted input to scripts [49].

## 13. Notification channels

- **ntfy.** Publishing is an HTTP `POST` or `PUT` of the message body to `https://HOST/TOPIC`. Headers: `Title`,
  `Priority` (1 to 5, default 3), `Tags`, `Click`, `Markdown`. JSON can be posted to the server root with `topic` and
  `message` fields. Topics are created on first use, names may use letters, digits, underscores and dashes up to 64
  characters, and on the public server anyone who knows the name can read it. Bodies over 4,096 bytes (or not UTF-8)
  become attachments. Protected topics take `Authorization: Basic ...` or `Bearer tk_...` [89]. Self-hosting: static
  binary (`ntfy serve`), deb/rpm/apt packages, or the `binwiederhier/ntfy` Docker image; the web UI and API listen on
  port 80 by default; config is `/etc/ntfy/server.yml` (not shipped in the image); `base-url` is a setting [90]. The
  "Limitations" section (rate limits) was cut off in the retrieved text **(unverified)**.
- **Slack incoming webhooks.** A Slack app with Incoming Webhooks turned on gives a unique URL bound to one channel;
  an HTTP `POST` with JSON `{"text": ...}` (optionally `blocks`) delivers a message; success is `200` with body `ok`;
  errors include `400`, `403`, `404` (`invalid_payload`, `channel_not_found`, `no_active_hooks`); the channel,
  username and icon cannot be overridden; the URL is a secret and Slack revokes leaked ones. The page states no rate
  limit [91].
- **SMTP email.** Message submission uses port 587 and requires SMTP AUTH support from the server; relay between
  servers stays on port 25; RFC 6409 is Internet Standard 72 (November 2011) built on RFC 5321 [92]. Client library
  and mail-server details were not researched.
- **In-app.** The app already stores refresh results in SQLite and serves them through server functions (see
  `community.ts`), and has a one-off CLI image; a report could be a page, a table row set or CLI output without any
  outbound channel. No source applies to this item.

## 14. If "starred" meant GitHub stars

`GET /user/starred` lists the authenticated user's starred repositories and `GET /users/{username}/starred` another
user's. Both take `sort` (`created` = when starred, the default, or `updated` = last pushed), `direction` (`desc`
default, `asc`), `per_page` (default 30, max 100) and `page`; pagination follows the `Link` header (`rel="next"`
etc.). The media type `application/vnd.github.star+json` adds a `starred_at` timestamp to each item. The second form
returns an empty list for a private profile unless the request is authenticated as that user. For fine-grained tokens
the permissions page lists both under the user permission "Starring: read" [42][43][35].

## Summary: signals available without an LLM

| Signal | Where it comes from | What it tells you | Caveat |
|---|---|---|---|
| Author is Dependabot | REST `user.login` = `dependabot[bot]`, `user.type` = `Bot`; GraphQL `author { login }`; search `author:app/dependabot` | The PR was opened by Dependabot | GraphQL login form not documented; `app/dependabot` is documented only by pattern [20][33] |
| Branch prefix and segments | REST `head.ref`, GraphQL `headRefName` | Ecosystem, dependency, version | `prefix`, separator, `template`, `max-length` (default 100, hash suffix) are configurable [8] |
| Labels | REST `labels[]`, GraphQL `labels` | `dependencies`, ecosystem, semver labels; `security` per source code | `labels` config replaces or disables them; semver labels need all three to exist; `security` not in docs pages read [8][14] |
| Title | `title` | Single bump, library requirement change, or group | Prefix configurable; format not documented as stable [8][12] |
| Commit-message YAML block | REST `GET pulls/{n}/commits` | Dependency name and version, `dependency-type`, `update-type`, `dependency-group` | Not documented as a format; `update-type` absent on observed indirect updates [4][15] |
| `fetch-metadata` outputs | Actions only | `update-type`, `alert-state`, `ghsa-id`, `cvss`, `compatibility-score` | Runs only in a workflow; lookups need a PAT or App token [3] |
| Conflicts | GraphQL `mergeable`; REST `mergeable` | `CONFLICTING` / `false` | `UNKNOWN` / `null` is transient; recompute may take a moment; REST list omits it [16][17] |
| Merge-box state | GraphQL `mergeStateStatus` | `CLEAN`, `UNSTABLE`, `BEHIND`, `BLOCKED`, `DIRTY`, `HAS_HOOKS` | `DRAFT` deprecated; `UNKNOWN` transient; REST `mergeable_state` values undocumented [17][16] |
| Review and draft state | GraphQL `reviewDecision`, `isDraft`; REST `draft` | Approved, changes requested, review required, draft | Null case of `reviewDecision` not described [17] |
| CI result | GraphQL `statusCheckRollup.state` and `contexts` (check runs plus statuses) | Combined state, each check's conclusion, `isRequired` | Fine-grained token access to check data unresolved [18][19][36] |
| Legacy commit statuses | REST combined status | `success` / `pending` / `failure` | Does not include check runs [23] |
| Required checks | REST `rules/branches/{branch}`; GraphQL `CheckRun.isRequired` | What gates the merge | Rule types returned not listed; strict mode makes "behind" block [24][25][18] |
| Failed job and step | REST `actions/runs/{id}/jobs` | Job `conclusion`, step name and number | Actions: read; GitHub Actions CI only [39] |
| Security fix | REST Dependabot alerts | Severity, GHSA, CVE, vulnerable range, first patched version | Dependabot alerts: read; no PR-number field, so matching is by package and version [37] |
| Auto-merge state | GraphQL `autoMergeRequest`; REST `auto_merge` | Whether auto-merge is already on | Behaviour with no required checks not stated [16][17][26] |
| Age and activity | REST `created_at`, `updated_at` | How long it has waited | Fields not retrieved on the docs pages; standard in the schema *(inference)* |

## Summary: signals that need reading prose

| Signal | Where it comes from | Permission needed |
|---|---|---|
| Release notes and changelog text, commit list | PR `body` (upstream text quoted by Dependabot) and the commit message links [12][15] | Pull requests: read |
| "Maintainer changes" phrase | PR `body`; `fetch-metadata` `maintainer-changes` [3] | Pull requests: read |
| Linked upstream release notes or changelog | Third-party pages the PR links to; outside the GitHub API | None from GitHub; outside this research |
| Compatibility score | Badge in the body; a number only through `fetch-metadata` `compat-lookup` [3] | Personal access token in Actions |
| Advisory `summary` / `description` | Dependabot alerts REST [37] | Dependabot alerts: read |
| Changed files and patches | REST `GET pulls/{n}/files` [35] | Pull requests: read |
| Job logs (plain text, 302 link valid 1 minute) | REST `actions/jobs/{id}/logs` [39] | Actions: read (classic: `repo` for private) |
| Run log archive | REST `actions/runs/{id}/logs` [40] | Actions: read (classic: `repo` for private) |
| Check-run `summary`, `text`, annotations | REST check runs and annotations; GraphQL `CheckRun.summary` / `text` [22][18] | Checks API: classic `repo`; fine-grained not resolved [36] |
| Review comments and review bodies | REST `pulls/{n}/reviews` [35] | Pull requests: read |

## Fit with gitlib

Read from this repository's code, not from the sources above. Numbers in brackets point at the sources above.

### "Starred" in this app

The Star button in the repo table (`components/repo-table.tsx`) calls `setFavorite` (`server/repos.ts`), which writes
`repo_favorites` in `gitlib.db`. So "all starred repos" is `RepoRecord.isFavorite`, a local flag, not GitHub stars.

- A favorite is only watchable if it has a GitHub remote. `groupReposByGitHubSlug` (`server/github.server.ts`) already
  turns repos into unique `owner/repo` slugs and collapses linked worktrees that share a remote, so the watch list is
  that function filtered by `isFavorite`. Favorites with no GitHub remote are absent today; a report should say how many
  were skipped and why.
- Repositories starred on GitHub without a clone (the catalog's star, `remote_favorites` in `gitlib.db`) are watched
  too: `addRemoteFavorites` (`packages/core/src/dependabot/check.ts`) adds them as watched repos with no checkout
  paths, de-duplicated against starred clones by slug. Ones starred on GitLab are listed as skipped, since only
  GitHub is checked.
- The GitHub-stars reading would watch repos that are not cloned locally and that the user may not own (section 14).
  That is a different feature.

### What exists to build on

| Existing piece | Where | Reuse |
|---|---|---|
| GitHub REST helper with timeout, token, rate-limit header, readable 404/403/429 errors | `githubGet` in `server/github.server.ts` | Fine for REST; there is no GraphQL helper, no pagination helper and no ETag support |
| Open-PR listing for one repo, shown in the repo page's Pull requests tab | `server/pulls.ts` | Shows PRs, not mergeability or checks |
| Background refresher: one run joined by callers, oldest first, a rate-limit reserve (`RATE_RESERVE = 12`), 6 concurrent requests, results written to SQLite | `server/community.ts` | The right shape for a GitHub-polling job; copy the ideas, not the module |
| Result cache table with `payload` JSON and `fetched_at` | `github_community_profiles` in `gitlib.db` | Precedent for storing last-fetched GitHub state so the UI works offline |
| One-off CLI service in the same image | `gitlib` service, `tools` profile, `docker-compose.yml` | An entry point for an external scheduler: `docker compose run --rm gitlib <command>` |
| Cron for a scheduled job | `docs/runbook.md` (backup schedule) | The project already schedules `scripts/backup.sh` from the host |
| Human-confirmed write into planning | "Add to planning" on the Community tab | The pattern for turning a "needs work" PR into a gitlib issue without the model writing anything |

### Where the existing scheduler falls short for this job

1. **It starts lazily.** `ensureScheduler()` runs from the two community server functions (`community.ts`), so after a
   restart nothing runs until someone opens a page that asks for community scores.
2. **It is interval-based, not calendar-based.** It checks hourly and refreshes what is older than N hours. "Every
   weekday at 08:00" is not expressible.
3. **It lives in the web process.** A crash or redeploy stops it, and a multi-minute LLM step would share that process.
   It does catch up after a restart, because staleness comes from stored `fetched_at`, not from in-memory timers.
4. **Its failure handling is tuned for one cheap call per repo.** Triage needs several calls per PR plus an LLM call, so
   partial failure has to be recorded per PR, not per run.

### Storage and ownership

- Findings are derived from GitHub and can be fetched again, which fits `gitlib.db` (it already holds the community cache
  through `CREATE TABLE IF NOT EXISTS`).
- Anything the *user* decides (dismiss, snooze, "I merged it elsewhere") cannot be re-derived. That is what put planning
  data in its own versioned `planning.db`, so decisions belong there under the append-only migration rule.
- `gitlib backup` already covers `config.toml`, `gitlib.db` and `planning.db`.

### Constraints the code forces

1. **Token scope.** `.env.example` says a read-only "Issues" token is enough. Triage needs more (pull requests, commit
   statuses, and see section 6 and the Recommendation for checks), and that token sits in the environment of a web app
   with no login and outside backups.
2. **Two SQLite habits.** `Store.withConnection` (`packages/core/src/store.ts`) opens `new DatabaseSync(path)` with no
   `timeout` and plain `BEGIN`; the planning store uses `timeout: 5_000` and `BEGIN IMMEDIATE`. The `web` and `gitlib`
   services mount the same `gitlib-data` volume, so a web process and a scheduled CLI process can write at once [77][79].
3. **Egress.** The container needs `api.github.com` and the LAN Ollama host; the image already carries `ca-certificates`.
4. **Tests.** CI has no network. GitHub and the model both sit behind interfaces with fakes, as `SearchBackend` does.
5. **Test bed.** `.github/dependabot.yml` runs Dependabot weekly on this repo for npm, GitHub Actions, Docker and
   docker-compose, so the feature can be exercised on real PRs from the first week.

## Recommendation

A proposal, not a decision. It is the author's reading of the findings; the reasons are the cited facts.

1. **Ship the report with no LLM first.** The verdict comes from fields GitHub returns (first summary table), so the
   job has value, is testable with fixtures and uses no GPU. Four buckets:
   - *Ready:* not a draft, `mergeable` is `MERGEABLE`, `mergeStateStatus` is `CLEAN`, the check rollup is successful, no
     review blocks it, and the update type is patch or minor [16][17][18].
   - *Review first:* green, but a major bump, an unknown update type (the commit-message block is undocumented and absent
     on indirect updates [15]), "Maintainer changes" in the body [3], or a matching security alert [37].
   - *Needs work:* failing required checks, conflicts (`DIRTY`), changes requested, or behind the base branch.
   - *Waiting:* checks pending, or mergeability still `UNKNOWN` (transient; look again later) [16][17].
2. **Suggest actions as text, never as commands the job runs.** Behind or conflicting: `@dependabot rebase` or
   `@dependabot recreate`; not wanted: the `ignore` variants [5]. The merge commands were retired on 2026-01-27, so the
   report must not tell anyone to type them [6]; it links to the PR instead. Posting a comment is a write, so a
   read-only token cannot do it anyway.
3. **Run the token experiment before writing code.** GitHub's token guide (re-read on 2026-11-02) lists the Checks API
   among the things fine-grained tokens cannot do, and says the gaps are not permanent [36]. Legacy commit statuses
   (permission "Commit statuses: read") do not include check runs, which is where GitHub Actions reports [23]. Whether
   GraphQL `statusCheckRollup` works with a fine-grained token is not documented. The commands in "Verify with your own
   token" settle it in a few minutes. Outcomes:
   - GraphQL rollup works: use fine-grained tokens, read-only, one per resource owner (a fine-grained token cannot span
     organisations [36]).
   - It does not: choose between a classic token (private repositories need `repo`, which also allows writes, in an app
     with no login) and a report that cannot tell whether CI is green. That is the owner's call.
4. **One GraphQL search per owner, not one REST call per repo.** `is:pr is:open author:app/dependabot user:OWNER
   archived:false`, with `mergeable`, `mergeStateStatus`, `reviewDecision`, labels and `statusCheckRollup` nested [17][33].
   A page of about 50 PRs costs about 1 point of the 5,000 an hour (derived; read `rateLimit { cost }` to confirm) [31].
   Filter to favorites by slug in code. Fall back to REST only for what GraphQL lacks (job logs, alerts).
5. **A core function with two callers.** `checkDependabot()` in `packages/core`, called by a CLI command (`gitlib
   dependabot check [--json]`) and a "Check now" button on the web page. Both write to `gitlib.db`.
6. **Schedule it outside the web process.** Run the CLI from the host scheduler on the always-on instance: a systemd
   timer with `Persistent=true` on a Linux homelab VM catches up runs missed while it was off [53]; launchd on a Mac runs
   a missed job on wake [54]. The project already schedules backups from cron. The in-process timer is the weakest fit
   for "while I'm away" (lazy start, stops with the web server, sleeps with the host) unless it is started at boot.
   Guard against two runs at once with a lease row taken under `BEGIN IMMEDIATE` and a busy timeout, the way the planning
   store opens its database [77][79].
7. **Store findings, not just a rendering.** Tables in `gitlib.db` for runs and per-PR findings (verdict, reasons,
   `fetched_at`, and later an explanation), so the page works offline and the history is queryable. Table names are open.
   Dismiss or snooze would be user data and belongs in `planning.db` with a migration.
8. **Add the LLM as a prose layer in the low-priority lane.** After the verdict, for *Needs work* and *Review first*
   rows only, ask the model for a short explanation from: the verdict's facts, the title, a length-capped slice of the PR
   body, and the names of failed jobs and steps (plus the end of a log if the token has Actions: read [39]). Store it
   with the model name, and show it under a label that says the verdict did not come from the model. The verdict never
   reads model output, so a hostile release note can at worst skew the prose [82][87]; the prose goes to the page
   through an image-free Markdown renderer [85]. It runs in the single GPU lane described in
   `docs/ollama-integration.md`, one PR at a time, behind any chat turn. Time per PR on a 3080 Ti was not measured.
9. **Notify last.** Start with the page, a `NavBar` badge and CLI output. ntfy or a Slack webhook can come later
   (section 13); a webhook URL is a secret [91], so it belongs in the environment, which backups exclude, not in
   `config.toml`.
10. **Let GitHub do the boring merges, if you want fewer rows.** Auto-merge is a repository feature that merges once
    required checks pass [26][27]; the docs' recipe enables it for patch updates from a workflow pinned to a full commit
    SHA, which matches this repo's own rule [1]. That is configured per repository on GitHub, outside gitlib; the report
    then lists only what is left. Report-only stays the default for gitlib itself.
11. **Order of work.** (a) The token experiment on one repo you own. (b) A pure `classify(pr)` function with fixtures
    taken from those real responses. (c) The GraphQL fetch and `gitlib dependabot check --json`, tried on this repo's own
    Dependabot PRs. (d) Tables, page, badge. (e) The schedule. (f) The LLM prose layer, after the lane exists.

Questions only the owner can answer: whether the repos are public, private, or in organisations (that decides the token),
which instance should run it, how often and where the notice should land, and whether "starred" does mean the app's
favorites.

## Verify with your own token

Run these against one of your own repositories. Use a throw-away fine-grained token limited to that repository with
read-only permissions, and set `TOKEN`, `OWNER`, `REPO`. Shapes come from the docs cited; nothing here was run by the
author of this note (see the anonymous-quota note in Context).

**1. Quota and headers** [29]

```bash
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" https://api.github.com/repos/$OWNER/$REPO
# expect: HTTP/2 200 and x-ratelimit-limit: 5000, -remaining, -used, -reset, -resource: core
```

**2. Open PRs, Dependabot only** [16]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/pulls?state=open&per_page=100" |
  jq '[.[] | select(.user.login=="dependabot[bot]") | {number, title, ref:.head.ref, type:.user.type, draft, auto_merge, labels:[.labels[].name]}]'
# expect: an array; items carry user.login/user.type, head.ref, labels[], draft, auto_merge, body; no mergeable field
```

**3. One PR's mergeability** [16]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/pulls/NUMBER" |
  jq '{mergeable, mergeable_state, merge_commit_sha}'
# expect: mergeable true|false|null (null: repeat after a moment); mergeable_state a string; merge_commit_sha set when true
```

**4. Commit message block** [15]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/pulls/NUMBER/commits" |
  jq -r '.[].commit.message'
# expect: "Bumps [x](...) from A to B." then --- / updated-dependencies: / - dependency-name: ... / ... / Signed-off-by
```

**5. GraphQL: list, merge state and CI in one call** [17][18][19][31]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -X POST https://api.github.com/graphql -d '{"query":"{ rateLimit { cost remaining resetAt } search(query: \"is:pr is:open author:app/dependabot repo:'$OWNER'/'$REPO'\", type: ISSUE, first: 20) { issueCount nodes { ... on PullRequest { number title headRefName isDraft mergeable mergeStateStatus reviewDecision author { __typename login } labels(first: 10) { nodes { name } } commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 20) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } } } } }"}'
# expect: data.rateLimit.cost (about 1 per the formula), data.search.issueCount, nodes[] with the fields above
# check: author.login with or without [bot]; whether statusCheckRollup is returned (not null, no permission error) for your token type
```

**6. Is a check required?** [18]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -X POST https://api.github.com/graphql -d '{"query":"{ repository(owner: \"'$OWNER'\", name: \"'$REPO'\") { pullRequest(number: NUMBER) { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 30) { nodes { ... on CheckRun { name conclusion isRequired(pullRequestNumber: NUMBER) } } } } } } } } } }"}'
```

**7. REST check runs, combined status, branch rules** [22][23][25]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/commits/SHA/check-runs"   # { total_count, check_runs[] with output.{title,summary,text,annotations_count} }
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/commits/SHA/status"       # { state, statuses[] }
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/rules/branches/main"      # array of active rules
# first call is the one to watch with a fine-grained token: a 200 here settles the Checks API question in section 6
```

**8. Dependabot alerts** [37]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/dependabot/alerts?state=open&per_page=100" |
  jq '[.[] | {number, state, pkg:.dependency.package.name, ghsa:.security_advisory.ghsa_id, cve:.security_advisory.cve_id, severity:.security_advisory.severity, range:.security_vulnerability.vulnerable_version_range, patched:.security_vulnerability.first_patched_version.identifier}]'
```

**9. Failing job and its log** [39]

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/actions/runs/RUN_ID/jobs" |
  jq '.jobs[] | {id, name, conclusion, failed_steps:[.steps[] | select(.conclusion=="failure") | .name]}'
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/actions/jobs/JOB_ID/logs"
# expect: HTTP/2 302 and a location: header; fetch that URL within one minute (try it without the Authorization header)
```

**10. Conditional request** [30]

```bash
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/pulls?state=open&per_page=100"   # note etag and x-ratelimit-remaining
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" -H 'If-None-Match: "ETAG"' "https://api.github.com/repos/$OWNER/$REPO/pulls?state=open&per_page=100"
# expect: HTTP/2 304 and x-ratelimit-remaining unchanged
```

**11. Stars** [42]

```bash
curl -sS -D - -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github.star+json" "https://api.github.com/user/starred?per_page=100"
# expect: array of { starred_at, repo }, and a Link header with rel="next" when there are more pages
```

## Sources

All read on 2026-11-02 unless a date is given. docs.github.com pages show no version number.

1. Automating Dependabot with GitHub Actions (tutorial), https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions (first read at the older path `/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions`)
2. Dependabot on GitHub Actions (reference), https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions
3. dependabot/fetch-metadata README, https://github.com/dependabot/fetch-metadata (no release version shown; usage example references `v3`)
4. dependabot/fetch-metadata source, `src/dependabot/update_metadata.ts` on `main`, https://raw.githubusercontent.com/dependabot/fetch-metadata/main/src/dependabot/update_metadata.ts
5. Dependabot pull request comment commands, https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands
6. GitHub Changelog, "Changes to GitHub Dependabot pull request comment commands", 2026-01-27, https://github.blog/changelog/2026-01-27-changes-to-github-dependabot-pull-request-comment-commands/
7. Managing pull requests for dependency updates, https://docs.github.com/en/code-security/dependabot/working-with-dependabot/managing-pull-requests-for-dependency-updates
8. Dependabot options reference (fetched at https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference; search results show it now at `/en/code-security/reference/supply-chain-security/dependabot-options-reference`; the page was read in two parts)
9. About Dependabot security updates, https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates
10. About Dependabot version updates, https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/about-dependabot-version-updates
11. Dependabot pull requests (concepts), https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-pull-requests
12. dependabot-core, `pull_request_creator/message_builder.rb` on `main`, https://raw.githubusercontent.com/dependabot/dependabot-core/main/common/lib/dependabot/pull_request_creator/message_builder.rb
13. dependabot-core, `pull_request_creator/branch_namer/solo_strategy.rb` on `main`, https://raw.githubusercontent.com/dependabot/dependabot-core/main/common/lib/dependabot/pull_request_creator/branch_namer/solo_strategy.rb
14. dependabot-core, `pull_request_creator/labeler.rb` on `main`, https://raw.githubusercontent.com/dependabot/dependabot-core/main/common/lib/dependabot/pull_request_creator/labeler.rb
15. Observed Dependabot PRs 762 to 767 in the public repository `dependabot/fetch-metadata`: the PR list at https://github.com/dependabot/fetch-metadata/pulls?q=is%3Apr+author%3Aapp%2Fdependabot, the page https://github.com/dependabot/fetch-metadata/pull/767, and the patches for PRs 763, 764 and 767 (served from https://patch-diff.githubusercontent.com/raw/dependabot/fetch-metadata/pull/NNN.patch); commits dated 2026-10-11 and 2026-10-31
16. REST API endpoints for pull requests, https://docs.github.com/en/rest/pulls/pulls
17. GraphQL reference, Pull requests, https://docs.github.com/en/graphql/reference/pulls (last 29 KB of the page not read)
18. GraphQL reference, Checks, https://docs.github.com/en/graphql/reference/checks
19. GraphQL reference, Commits, https://docs.github.com/en/graphql/reference/commits
20. GraphQL reference, Users (Actor), https://docs.github.com/en/graphql/reference/users
21. GraphQL reference, Search, https://docs.github.com/en/graphql/reference/search
22. REST API endpoints for check runs, https://docs.github.com/en/rest/checks/runs (the "Fine-grained access tokens" sections did not appear in the retrieved text)
23. REST API endpoints for commit statuses, https://docs.github.com/en/rest/commits/statuses
24. About protected branches, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
25. REST API endpoints for rules, "Get rules for a branch", https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch
26. Automatically merging a pull request, https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
27. Managing auto-merge for pull requests in your repository, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository
28. GitHub CLI manual, `gh pr merge`, https://cli.github.com/manual/gh_pr_merge
29. Rate limits for the REST API, https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api (plus the author's own anonymous request to `api.github.com` on 2026-11-02, which returned 403 with a 60/60 quota)
30. Best practices for using the REST API, https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
31. Rate limits and node limits for the GraphQL API, https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api
32. REST API endpoints for search, https://docs.github.com/en/rest/search/search
33. Searching issues and pull requests, https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
34. Filtering and searching issues and pull requests, https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests
35. Permissions required for fine-grained personal access tokens, https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens (the "Checks" section was not present in the retrieved text)
36. Managing your personal access tokens, https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
37. REST API endpoints for Dependabot alerts, https://docs.github.com/en/rest/dependabot/alerts (marked public preview; the fine-grained permission sentence was not in the retrieved text)
38. About Dependabot alerts, https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts
39. REST API endpoints for workflow jobs, https://docs.github.com/en/rest/actions/workflow-jobs
40. REST API endpoints for workflow runs, https://docs.github.com/en/rest/actions/workflow-runs
41. Configuring the retention period for GitHub Actions artifacts and logs in your organization, https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization
42. REST API endpoints for starring, https://docs.github.com/en/rest/activity/starring
43. Using pagination in the REST API, https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
44. About webhooks, https://docs.github.com/en/webhooks/about-webhooks
45. Best practices for using webhooks, https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
46. Handling failed webhook deliveries, https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
47. Creating webhooks, https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks
48. Testing webhooks, https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks
49. Secure use reference (GitHub Actions), https://docs.github.com/en/actions/reference/security/secure-use
50. Node.js v24.x documentation, Timers (shows v24.22.2), https://nodejs.org/docs/latest-v24.x/api/timers.html
51. Node.js v24.x documentation, SQLite (shows v24.22.2; last 2 KB not read), https://nodejs.org/docs/latest-v24.x/api/sqlite.html
52. Node.js latest documentation, SQLite (header shows v26.13.0; last 13 KB not read), https://nodejs.org/api/sqlite.html
53. systemd.timer(5), `latest` manual page (shows systemd 262), https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
54. Apple, Daemons and Services Programming Guide, "Scheduling Timed Jobs" (archive, updated 2016-09-13), https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html
55. cronie, `man/cron.8` on `master`, https://raw.githubusercontent.com/cronie-crond/cronie/master/man/cron.8
56. Docker Compose, Using profiles, https://docs.docker.com/compose/how-tos/profiles/
57. `docker compose run`, https://docs.docker.com/reference/cli/docker/compose/run/
58. Docker Engine, Start containers automatically (restart policies), https://docs.docker.com/engine/containers/start-containers-automatically/
59. Third-party: aptible/supercronic README, https://github.com/aptible/supercronic (release version not captured)
60. Third-party: mcuadros/ofelia README, https://github.com/mcuadros/ofelia (release version and archive status not captured)
61. Third-party: netresearch/ofelia, https://github.com/netresearch/ofelia (seen in search results only; its v1.0.1 release was listed, README not read)
62. Events that trigger workflows, `schedule`, https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
63. Disabling and enabling a workflow, https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows
64. About self-hosted runners, https://docs.github.com/en/actions/concepts/runners/self-hosted-runners
65. Self-hosted runners reference, https://docs.github.com/en/actions/reference/runners/self-hosted-runners
66. Ollama FAQ, https://docs.ollama.com/faq
67. Ollama API, Errors, https://docs.ollama.com/api/errors
68. Ollama source, `server/sched.go`, `main` and tag `v0.40.13`, https://raw.githubusercontent.com/ollama/ollama/main/server/sched.go and https://raw.githubusercontent.com/ollama/ollama/v0.40.13/server/sched.go
69. Ollama source, `server/routes.go`, `main`, https://raw.githubusercontent.com/ollama/ollama/main/server/routes.go (read in two parts)
70. Ollama source, `llm/llama_server.go`, `main` and tag `v0.40.13`, https://raw.githubusercontent.com/ollama/ollama/main/llm/llama_server.go and https://raw.githubusercontent.com/ollama/ollama/v0.40.13/llm/llama_server.go (`llm/server.go` was read as well and defines types only)
71. Ollama source, `llm/server.go`, `main`, https://raw.githubusercontent.com/ollama/ollama/main/llm/server.go
72. Ollama source, `envconfig/config.go`, `main`, https://raw.githubusercontent.com/ollama/ollama/main/envconfig/config.go
73. Ollama releases, https://github.com/ollama/ollama/releases/latest (`v0.40.13`, "28 Oct")
74. Third-party (upstream of the runner): llama.cpp server README, https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
75. Go `net/http`, `Request.Context`, https://pkg.go.dev/net/http#Request (page shows Go 1.27.3)
76. Go `golang.org/x/sync/semaphore`, https://pkg.go.dev/golang.org/x/sync/semaphore (shows v0.24.0, published 2026-09-23)
77. SQLite, BEGIN TRANSACTION (last updated 2026-02-18), https://www.sqlite.org/lang_transaction.html
78. SQLite, Write-Ahead Logging (last updated 2026-08-25), https://www.sqlite.org/wal.html
79. SQLite, `sqlite3_busy_timeout`, https://www.sqlite.org/c3ref/busy_timeout.html
80. SQLite, File locking and concurrency in version 3 (last updated 2025-05-31), https://www.sqlite.org/lockingv3.html
81. OWASP GenAI Security Project, Top 10 for LLM Applications 2025, https://genai.owasp.org/llm-top-10/
82. OWASP LLM01:2025 Prompt Injection, https://genai.owasp.org/llmrisk/llm01-prompt-injection/
83. OWASP LLM02:2025 Sensitive Information Disclosure, https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/
84. OWASP LLM03:2025 Supply Chain, https://genai.owasp.org/llmrisk/llm032025-supply-chain/
85. OWASP LLM05:2025 Improper Output Handling, https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/
86. OWASP LLM06:2025 Excessive Agency, https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
87. OWASP LLM09:2025 Misinformation, https://genai.owasp.org/llmrisk/llm092025-misinformation/
88. OWASP LLM10:2025 Unbounded Consumption, https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/
89. ntfy docs, Publishing, https://docs.ntfy.sh/publish/ (read to character 200,000 of about 206,000; the Limitations section was cut off)
90. ntfy docs, Installation, https://docs.ntfy.sh/install/
91. Slack, Sending messages using incoming webhooks, https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
92. RFC 6409, Message Submission for Mail (STD 72, November 2011), https://www.rfc-editor.org/rfc/rfc6409
