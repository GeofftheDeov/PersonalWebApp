# Personal Web App

A full-stack personal web application featuring a Next.js frontend and an Express/MongoDB backend with Salesforce integration.

## Project Structure

- `frontend/`: Next.js application (React, Tailwind CSS, Framer Motion)
- `backend/`: Express.js server (MongoDB, Salesforce JSforce integration)
- `shared/`: (Planned) Shared types and utilities

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
