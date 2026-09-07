# ============================================================
# Stage 1 — Build the React frontend
# ============================================================

FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-build

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json* ./

RUN npm ci 2>/dev/null || npm install

COPY frontend/ ./

RUN npm run build


# ============================================================
# Stage 2 — Install API dependencies
# ============================================================

FROM --platform=$BUILDPLATFORM node:22-alpine AS api-deps

WORKDIR /app/api

COPY api/package.json api/package-lock.json* ./

RUN npm ci --omit=dev


# ============================================================
# Stage 3 — Final application image
#
# This single container contains:
#
#   nginx → React frontend
#   node  → openGym API
#
# nginx proxies /api/* to Node on localhost:3000.
# Exercise images/GIFs are NOT packaged into this image.
# They are served from the pinned jsDelivr dataset and
# cached locally by the service worker.
# ============================================================

FROM node:22-alpine

WORKDIR /app

# Install nginx.
RUN apk add --no-cache nginx \
    && mkdir -p /run/nginx


# ----------------------------
# Node API
# ----------------------------

COPY --from=api-deps /app/api/node_modules ./api/node_modules
COPY api/package.json ./api/package.json
COPY api/server.js ./api/server.js
COPY api/storage.js ./api/storage.js


# ----------------------------
# React frontend
# ----------------------------

COPY --from=frontend-build /app/dist /usr/share/nginx/html


# ----------------------------
# nginx configuration
# ----------------------------

COPY web/nginx.conf /etc/nginx/http.d/default.conf


# ----------------------------
# nginx listens on port 80.
# Render exposes this container port.
# ----------------------------

EXPOSE 80


# ----------------------------
# Start Node API + nginx.
#
# Node:
#   3000
#
# nginx:
#   80
# ----------------------------

CMD ["sh", "-c", "node /app/api/server.js & exec nginx -g 'daemon off;'"]