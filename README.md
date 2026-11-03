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

The frontend and `packages/*` are one npm workspace, with one lockfile at the repo root.

1. Install dependencies from the repo root: `npm install` (or `npm ci`)
2. Start the development server: `cd frontend && npm run dev`
3. Check: `npm run typecheck` and `npm test` at the root run every workspace's; `cd frontend && npm run build` runs the build the deploy runs.

The frontend image builds from the repo root: `docker build -f frontend/Dockerfile .`

## Deployment

The application is containerized with Docker. Use `docker-compose up` to run the entire stack locally in containers.
