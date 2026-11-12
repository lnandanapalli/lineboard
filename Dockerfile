# syntax=docker/dockerfile:1

# ---- build ----
FROM node:22-alpine AS build
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
RUN chmod +x /docker-entrypoint.d/40-lineboard-config.sh
EXPOSE 80
