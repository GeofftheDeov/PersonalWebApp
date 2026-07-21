# Personal Web App

A full-stack personal web application featuring a Next.js frontend and an Express/MongoDB backend with Salesforce integration.

## Project Structure

- `frontend/`: Next.js application (React, Tailwind CSS, Framer Motion)
- `backend/`: Express.js server (MongoDB, Salesforce JSforce integration)
- `shared/`: (Planned) Shared types and utilities
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
3. Create a `.env` file (see `.env.example`)
4. Start the server: `npm run dev`

### Frontend Setup

1. Navigate to `frontend/`
2. Install dependencies: `npm install`
3. Start the development server: `npm run dev`

## Deployment

The application is containerized with Docker. Use `docker-compose up` to run the entire stack locally in containers.
