# PersonalWebApp

## Pull requests

`dev` is the PR target: open every PR against `dev` (`gh pr create --base dev`), even though `main` is the repo's default branch. Pushes to `dev` deploy the dev environment, where changes get tested before they reach prod. A PR into `main` is a promotion, opened only when the user explicitly asks for one.

Cut the branch from `main` (the worktree default). CI rebases `dev` onto `main` after every prod deploy, so `dev` is `main` plus a few commits: a `main`-based branch shows a clean diff against `dev`, and the same branch can later be promoted to `main` carrying only its own commits.
