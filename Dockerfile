# syntax=docker/dockerfile:1

# ---- build ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- serve ----
FROM nginx:1.31-alpine
LABEL org.opencontainers.image.title="Lineboard" \
      org.opencontainers.image.description="Handwriting whiteboard with strip-lock palm rejection" \
      org.opencontainers.image.licenses="MIT"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
# Writes config.js from SUPABASE_URL / SUPABASE_ANON_KEY every time the container starts.
COPY docker/40-lineboard-config.sh /docker-entrypoint.d/40-lineboard-config.sh
# Optional www <-> bare-domain redirect from CANONICAL_HOST, also written at every start.
COPY docker/41-lineboard-canonical-host.sh /docker-entrypoint.d/41-lineboard-canonical-host.sh
# Which proxies may name the client in X-Forwarded-For (rate limiting), from TRUSTED_PROXIES.
COPY docker/42-lineboard-trusted-proxies.sh /docker-entrypoint.d/42-lineboard-trusted-proxies.sh
RUN chmod +x /docker-entrypoint.d/40-lineboard-config.sh /docker-entrypoint.d/41-lineboard-canonical-host.sh /docker-entrypoint.d/42-lineboard-trusted-proxies.sh \
 && touch /etc/nginx/snippets/canonical-host.conf /etc/nginx/snippets/trusted-proxies.conf
EXPOSE 80
