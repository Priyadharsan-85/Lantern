# Stage 1 — Build the React app with Vite
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Accept collector URL as a build arg so the JS bundle knows where to call
ARG VITE_COLLECTOR_URL=http://localhost:4000
ENV VITE_COLLECTOR_URL=$VITE_COLLECTOR_URL

# Build production bundle
RUN npm run build

# Stage 2 — Serve with Nginx
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom Nginx config (SPA routing + /api proxy)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
