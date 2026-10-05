#!/bin/bash
# Perplexity Relay Setup Script — run this on your VPS
# This script installs the relay proxy + configures nginx to forward /session to it.
#
# Usage: bash setup-vps-relay.sh
#
# After running this:
#   1. The relay runs on port 3004
#   2. Nginx proxies /session → localhost:3004
#   3. The Cloudflare Tunnel exposes it via your trycloudflare URL
#   4. Set PERPLEXITY_RELAY_URL=https://your-tunnel-url in the .env

set -e

echo "=== Perplexity Relay Setup ==="

# 1. Install bun if not available
if ! command -v bun &> /dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# 2. Clone the repo (or just the relay folder)
RELAY_DIR="$HOME/perplexity-relay"
if [ ! -d "$RELAY_DIR" ]; then
  echo "Cloning relay code..."
  git clone https://github.com/nelciajulie-droid/OKAY.git /tmp/okay-repo
  cp -r /tmp/okay-repo/mini-services/perplexity-relay "$RELAY_DIR"
  rm -rf /tmp/okay-repo
fi

# 3. Install dependencies
cd "$RELAY_DIR"
echo "Installing dependencies..."
bun install

# 4. Start the relay in the background
echo "Starting relay on port 3004..."
bun run dev &
RELAY_PID=$!
sleep 2

# Verify the relay is running
if curl -sS -m 5 -o /dev/null -w "%{http_code}" "http://localhost:3004/" | grep -q "200"; then
  echo "✓ Relay is running on http://localhost:3004"
else
  echo "✗ Relay failed to start"
  exit 1
fi

# 5. Configure nginx to proxy /session to localhost:3004
NGINX_CONF="/etc/nginx/sites-available/perplexity-relay"
NGINX_LINK="/etc/nginx/sites-enabled/perplexity-relay"

echo "Configuring nginx..."

# Detect the nginx config directory
if [ -d "/etc/nginx/conf.d" ]; then
  NGINX_CONF="/etc/nginx/conf.d/perplexity-relay.conf"
  NGINX_LINK=""
elif [ -d "/etc/nginx/sites-available" ]; then
  NGINX_CONF="/etc/nginx/sites-available/perplexity-relay"
  NGINX_LINK="/etc/nginx/sites-enabled/perplexity-relay"
else
  NGINX_CONF="/etc/nginx/conf.d/perplexity-relay.conf"
  NGINX_LINK=""
fi

# Find the existing nginx server block (the tunnel's server_name)
TUNNEL_HOST=$(grep -r "trycloudflare" /etc/nginx/ 2>/dev/null | head -1 | grep -oE "server_name\s+[^;]+" | awk '{print $2}' || echo "")

cat > "$NGINX_CONF" << NGINXEOF
# Perplexity relay proxy — forwards /session to the relay on port 3004
location /session {
    proxy_pass http://localhost:3004;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
}
NGINXEOF

# If using sites-available, create the symlink
if [ -n "$NGINX_LINK" ]; then
  ln -sf "$NGINX_CONF" "$NGINX_LINK"
fi

# Test + reload nginx
echo "Testing nginx config..."
nginx -t 2>&1
echo "Reloading nginx..."
nginx -s reload 2>&1 || systemctl reload nginx 2>&1

echo ""
echo "=== Setup complete! ==="
echo "The relay is running on port 3004."
echo "Nginx proxies /session → localhost:3004."
echo ""
echo "Your Cloudflare Tunnel URL should now work for Perplexity."
echo "Set PERPLEXITY_RELAY_URL=https://your-tunnel-url in the .env"
echo ""
echo "To test: curl -X POST https://your-tunnel-url/session -H 'Content-Type: application/json' -d '{\"sdp\":\"v=0\",\"cookies\":\"test\"}'"
