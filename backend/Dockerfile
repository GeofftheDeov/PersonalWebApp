# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --only=production

COPY --from=builder /app/dist ./dist
# Copy other necessary files if they are not part of the build (like certs if needed)
COPY --from=builder /app/key.pem ./key.pem
COPY --from=builder /app/cert.pem ./cert.pem

COPY entrypoint.sh ./entrypoint.sh
# Strip Windows CRLF line endings (a CRLF shebang makes exec fail with "no such file or directory")
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod +x ./entrypoint.sh

EXPOSE 5000
EXPOSE 5001

ENV NODE_ENV=production

ENTRYPOINT ["./entrypoint.sh"]
