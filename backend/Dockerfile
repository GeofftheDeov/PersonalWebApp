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

COPY package*.json ./
RUN npm install --only=production

COPY --from=builder /app/dist ./dist
# Copy other necessary files if they are not part of the build (like certs if needed)
# COPY --from=builder /app/certs ./certs

EXPOSE 5000

ENV NODE_ENV=production

CMD ["npm", "start"]
