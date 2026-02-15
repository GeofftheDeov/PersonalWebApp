# Frontend Application

The frontend of the Personal Web App, built with Next.js and Tailwind CSS.

## Features

- **Modern UI**: Built with React and Tailwind CSS for a responsive, high-performance interface.
- **Animations**: Subtle micro-animations and transitions powered by Framer Motion.
- **Dynamic Backgrounds**: Interactive, industrial-themed backgrounds.
- **Secure Dashboard**: User authentication integration with the backend service.

## Tech Stack

- **Framework**: Next.js (App Router)
- **Styling**: Tailwind CSS
- **Animations**: Framer Motion
- **Icons**: Lucide React

## Getting Started

### Installation

```bash
npm install
```

### Development

Run the development server with local IP binding (useful for ngrok/tunnel testing):

```bash
npm run dev
```

For HTTPS development (required for some Salesforce features/embeddings):

```bash
npm run dev:https
```

## Environment Variables

Create a `.env.local` file with the following:

- `NEXT_PUBLIC_API_URL`: The URL of the backend service (e.g., `http://localhost:5000/api`)

## Deployment

The frontend is configured for deployment on Vercel or as a containerized app via the root `docker-compose.yml`.
