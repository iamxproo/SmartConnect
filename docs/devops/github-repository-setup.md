# GitHub repository setup

Everything here changes **remote** state, so each step needs explicit approval from the repository owner before it is run. Nothing in this document has been executed. Replace `OWNER/REPO` with the existing SmartConnect repository.

## 0. Prerequisites

```bash
gh auth login                 # interactive; needs a token with repo + admin:org (for teams) scopes
gh repo view OWNER/REPO       # confirm it is the EXISTING SmartConnect repository
```

## 1. Link this working tree to the existing repository

The local folder is not yet a git repository. Do **not** run `git init` + `push --force`: link to the existing history instead.

```bash
cd SmartConnect
git init -b main
git remote add origin https://github.com/OWNER/REPO.git
git fetch origin                              # read-only

# A) Remote has history: check out its default branch over the local files. git refuses (and lists
#    the paths) if a remote file would overwrite an untracked local one, so nothing is lost silently.
git switch -c chore/monorepo-foundation --track origin/main   # adjust if the default branch differs
git status                                                     # review every difference before committing

# B) Remote is empty: stay on main.
git status --ignored          # confirm .env, .env.migration, backups, node_modules, generated/ are ignored
```

Then commit and open a pull request (or, for an empty repository, push `main` and create `develop`):

```bash
git add -A && git status                      # review: no secrets, no backups, no node_modules
git commit -m "chore: monorepo, database foundation, CI and team workflow"
git push -u origin HEAD                       # needs approval
git switch -c develop main && git push -u origin develop   # empty-repository case only
```

## 2. Branch protection (rulesets)

Ruleset definitions are versioned in [`.github/rulesets/`](../../.github/rulesets/):

| Ruleset | Target | Rules |
|---|---|---|
| [`main.json`](../../.github/rulesets/main.json) | `main` | No deletion or force-push; PR required, 2 approvals, stale approvals dismissed, last push must be approved by someone else, conversations resolved; merge or squash; required checks below, branch up to date |
| [`develop.json`](../../.github/rulesets/develop.json) | `develop` | Same, with 1 approval and squash only |

**Required status checks:**
- Format & lint
- Backend (schemas, typecheck, unit tests, build)
- Migrations, privileges, tenant isolation, backup/restore
- npm audit + registry signatures

Add *Frontend web* and *Frontend mobile* once those apps exist. GitHub counts a skipped required job as passing.

```bash
gh api -X POST repos/OWNER/REPO/rulesets --input .github/rulesets/main.json
gh api -X POST repos/OWNER/REPO/rulesets --input .github/rulesets/develop.json
gh api -X PATCH repos/OWNER/REPO -f default_branch=develop          # PRs target develop by default
```

Status checks only become selectable after the workflows have run once on the repository.

## 3. Repository settings

```bash
gh api -X PATCH repos/OWNER/REPO \
  -F allow_squash_merge=true -F allow_merge_commit=true -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

- **Actions:**
  - Settings → Actions → General → *Workflow permissions: Read repository contents* (the default for new repos). Leave "Allow GitHub Actions to create and approve pull requests" off.
  - Require approval for first-time contributor workflows.
  - Optionally allow only GitHub-authored and verified actions (all ours are `actions/*`).
- **Security:**
  - Enable the dependency graph, **Dependabot alerts** and **Dependabot security updates**, and **private vulnerability reporting** (used by [SECURITY.md](../../SECURITY.md)).
  - Secret scanning + push protection and CodeQL are free on public repositories; private repositories need GitHub Advanced Security. That is a decision for the owner.
- **Labels** used by templates and Dependabot (`bug`, `enhancement`, `dependencies`) exist by default or are auto-created. Optionally add `area/*` labels.

## 4. CODEOWNERS

[`.github/CODEOWNERS`](../../.github/CODEOWNERS) is committed **inactive** (all rules commented out), because GitHub cannot resolve owners until the teams exist. Recommended teams:

| Team | Owns | Why |
|---|---|---|
| `smartconnect-maintainers` | default `*` | Fallback reviewers |
| `smartconnect-platform` | `infrastructure/`, `.github/`, root `package.json`/lockfile, `SECURITY.md` | CI, supply chain, deployment |
| `smartconnect-db-owners` | `services/*/prisma/`, `services/*/src/database/`, `infrastructure/compose/postgres/`, `tests/security/`, `docs/database/` | Migrations, RLS and privileges are security boundaries |
| `smartconnect-backend` | `smartconnect-backend/`, `packages/` | Service code |
| `smartconnect-frontend` | `smartconnect-frontend/`, `packages/` | Web and mobile apps |

With a small team, individual usernames work too. Activate the file, then enable *Require review from Code Owners* (`"require_code_owner_review": true`) in both rulesets.

## 5. Later

- **Environments:** `staging` and `production`, with required reviewers and environment-scoped secrets, when deployment workflows are added.
- **Merge queue** on `develop` once PR volume makes "branch must be up to date" painful.
