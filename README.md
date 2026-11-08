# Personal Web App

A full-stack personal web application featuring a Next.js frontend and an Express/MongoDB backend with Salesforce integration.

## Project Structure

- `frontend/`: Next.js application (React, Tailwind CSS, Framer Motion)
- `backend/`: Express.js server (MongoDB, Salesforce JSforce integration)
- `packages/shared/`: `@gtd/shared`, the code the portfolio and Hearthside share (so far the API client)
- `resume-review` (compose service): Stan's Resume Review Flask app, built from
  the sibling repo at `../resume_review/resume_review` (both repos must be
  checked out side by side). Served on host port **5002** (container 5000).
  Supports OpenAI and Anthropic Claude; users may paste their own API key in
  the UI per request, or set `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in the
  compose environment for server-side defaults.

## Getting Started

### Prerequisites

- Node.js (v18+)
- MongoDB (local or Atlas)
- Salesforce Developer Org (for integration features)

### Backend Setup

1. Navigate to `backend/`
2. Install dependencies: `npm install`
3. Create a `.env` file (see `.env.example`). Set `JWT_SECRET` to a random string, e.g. the output of
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The backend refuses to
   start without one, in dev as well as production, and there is no default.
4. Start the server: `npm run dev`

### Frontend Setup

There are two frontends on the one backend: the portfolio (`frontend/`) and Hearthside (`hearthside/`), the
Game Night planner's own site. With `packages/*` (the code they share, `@gtd/shared`) they're one npm workspace,
with one lockfile at the repo root.

1. Install dependencies from the repo root: `npm install` (or `npm ci`)
2. Run everything: `npm run dev` at the repo root starts the backend (http://localhost:5000), the portfolio
   (http://localhost:3000) and Hearthside (http://localhost:3002) together, with their output in one terminal.
   It needs the backend set up as above. Both sites proxy `/api` to the backend and share the session cookie,
   so logging in on one logs you in on the other; for Letters' live updates on Hearthside, add
   `http://localhost:3002` to `SESSION_COOKIE_ORIGINS` in `backend/.env`.
   One app on its own: `cd frontend && npm run dev`, or `cd hearthside && npm run dev` (with `PORT`,
   `BACKEND_URL` and `NEXT_PUBLIC_PORTFOLIO_URL` to point it elsewhere).
3. Check: `npm run typecheck` and `npm test` at the root run every workspace's; `npm run build` in `frontend/`
   or `hearthside/` runs the build the deploy runs.

Both images build from the repo root: `docker build -f frontend/Dockerfile .` and
`docker build -f hearthside/Dockerfile .` (build args in each Dockerfile).

## Deployment

The application is containerized with Docker. Use `docker-compose up` to run the entire stack locally in containers.

Dev and prod each run as one ECS task with three containers: the backend (5000), the portfolio (3000/3001) and
Hearthside (3002), behind one ALB that picks the container by host. Pushes to `dev` deploy dev
(`dev-aws-workflow.yml`) and pushes to `main` deploy prod (`backend-aws-workflow.yml`); both build all three images.

Hearthside's load balancer rule, certificate, DNS and Google origins are set up by hand, once per environment, with
`scripts/hearthside-wizard.sh dev` (then `prod`). Its last stage turns on `HEARTHSIDE_LIVE`, the GitHub environment
variable that gives the backend `HEARTHSIDE_URL` and the portfolio its Hearthside links. Until then the Hearthside
container runs but nothing routes or links to it.
