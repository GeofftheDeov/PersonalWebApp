#!/bin/bash

# Start Docker Containers
echo "Starting Docker Containers (excluding MongoDB)..."
docker-compose up --build -d backend frontend

# Wait for containers to spin up
sleep 5

# Start Cloudflare Tunnel (assuming app runs on port 3000)
echo "Starting Cloudflare Tunnel..."

# Run cloudflared tunnel (targeting HTTPS origin)
npx cloudflared tunnel --url https://localhost:3000 --no-tls-verify &

CF_PID=$!

echo "Services started."
echo "Cloudflare Tunnel PID: $CF_PID"
echo "Press Ctrl+C to stop the tunnel (Containers will keep running)."

# Trap Ctrl+C to kill Cloudflare Tunnel
trap "kill $CF_PID; exit" SIGINT

# Wait for Tunnel
wait
