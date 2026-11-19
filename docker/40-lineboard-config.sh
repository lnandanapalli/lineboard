#!/bin/sh
# Generates the browser runtime config from container environment variables.
# The anon/publishable key is designed to be public; never put the service_role key here.
set -eu
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cat > /usr/share/nginx/html/config.js <<EOF
window.__LINEBOARD_CONFIG__ = { supabaseUrl: "$(esc "${SUPABASE_URL:-}")", supabaseAnonKey: "$(esc "${SUPABASE_ANON_KEY:-}")", turnstileSiteKey: "$(esc "${TURNSTILE_SITE_KEY:-}")" };
EOF
echo "lineboard: wrote config.js (supabase url: ${SUPABASE_URL:-<none, local mode>}, bot check: ${TURNSTILE_SITE_KEY:+on}${TURNSTILE_SITE_KEY:-off})"
