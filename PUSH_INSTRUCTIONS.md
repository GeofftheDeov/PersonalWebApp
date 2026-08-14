# Push instructions — resume-review integration

I could not push from here: the sandbox has no GitHub write credentials
(no token, no SSH key, and `github.com` doesn't resolve over SSH). Everything
below is prepared and verified — these are the commands to finish it.

---

## 1. Clean up a stale worktree entry I left behind

My first attempt used `git worktree`, which failed partway because the
OneDrive-backed `.git` directory rejects file deletions from the sandbox
("Operation not permitted"). A dangling entry is left in your repo:

```bash
cd C:\Users\Geoffrey\Documents\GitHub\PersonalWebApp
git worktree prune
```

Your working tree, branch, and all 3 stashes are untouched and verified intact.

---

## 2. Push the PersonalWebApp change and open a PR

The commit is prepared as a patch: `resume-review-container.patch` (repo root,
untracked — delete it after applying).

```bash
cd C:\Users\Geoffrey\Documents\GitHub\PersonalWebApp
git stash push README.md docker-compose.yml -m "wip resume-review"   # park your working copies
git fetch origin dev
git checkout -b feat/resume-review-container origin/dev
git am resume-review-container.patch
git push -u origin feat/resume-review-container
gh pr create --base dev --fill    # or open the PR in the GitHub UI
```

**Why branch from `origin/dev` and not your current branch:** `dev` was
force-pushed recently — its history was rewritten (old `da955ba4` →
new `91ca9c31`, `63808f96` → `f4d2dc0d`, `1ce0fb2c` → `2b63eb45`; same commit
messages, new hashes). Your local `security/mur-169-dev-taskdef-anthropic-alpaca`
is still built on the **pre-rewrite** history, so it shows 7 commits "ahead" of
dev that are really stale duplicates. Branching off it and pushing would have
shoved that purged history back onto GitHub. Given the branch names
(`migrate ANTHROPIC/ALPACA keys to Secrets Manager`) and the `filter-branch:
rewrite` entry in your stash list, that rewrite looks like a credential scrub —
worth **not** undoing by accident. The patch applies cleanly onto current dev;
I verified both files are byte-identical between the two bases.

**Not included in the commit:** `backend/routes/friendRoutes.ts`. You have an
uncommitted trailing-newline edit to it, and it's unrelated to this work. Note
that dev's copy of that file has *also* changed since your edit — your working
version is backed up at `/tmp/pwa-backup/friendRoutes.ts.working` in my sandbox
(ephemeral), so re-do the edit against the current dev version rather than
restoring a stale copy.

---

## 3. The bigger gap: `resume_review` is not a git repository

This is the main thing to flag. `C:\Users\Geoffrey\Documents\GitHub\resume_review`
has **no `.git` directory at all**. The PR above therefore contains only
**2 files / 28 lines** — the compose service and README notes.

Everything substantive lives in Stan's folder and is currently version-controlled
nowhere:

- `Dockerfile`, `.dockerignore` (new)
- `backend/resume_review.py` — OpenAI/Anthropic provider abstraction
- `backend/app.py` — provider + per-request key wiring
- `frontend/templates/upload.html`, `result.html` — provider/key UI
- `requirements.txt`, `README.md`

Until it's a repo, `docker-compose up resume-review` only works on machines that
already happen to have that folder — including CI. To version it:

```bash
cd C:\Users\Geoffrey\Documents\GitHub\resume_review\resume_review
git init && git add -A && git status     # REVIEW THIS OUTPUT BEFORE COMMITTING
git commit -m "Initial commit: resume review app with OpenAI + Claude support"
gh repo create resume_review --private --source=. --push
```

I extended the existing `.gitignore` to also exclude `.venv/`, `*.pdf`, and
`*.docx`. That matters: `.env` (already ignored) holds an OpenAI key, and the
repo root contains real resumes — `Resume-STANTON-MURRAY-Titan-Flood.pdf`,
plus more under `backend/uploads/`. **Check `git status` before that first
commit** so none of it goes up, especially if the repo is ever made public.

---

## 4. Test locally

```bash
cd C:\Users\Geoffrey\Documents\GitHub\PersonalWebApp
docker-compose up --build resume-review
# → http://localhost:5002
```

Also worth confirming: I defaulted `ANTHROPIC_MODEL` to `claude-sonnet-5`.
Verify that string against your API access and override in the environment if
it doesn't match.
