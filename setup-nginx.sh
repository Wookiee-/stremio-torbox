#!/usr/bin/env bash
# ==============================================================================
# Setup Nginx Reverse Proxy + Let's Encrypt SSL (Certbot) for Stremio-TorBox
# ==============================================================================

set -e

if [ "$EUID" -ne 0 ]; then
  echo "[-] Please run this script as root or with sudo:"
  echo "    sudo ./setup-nginx.sh [domain] [email]"
  exit 1
fi

DOMAIN="$1"
EMAIL="$2"
PORT="${3:-7000}"

# Prompt for Domain if not provided as argument
if [ -z "$DOMAIN" ]; then
  read -rp "Enter your domain name (e.g. torbox.example.com): " DOMAIN
fi

if [ -z "$DOMAIN" ]; then
  echo "[-] Error: Domain name is required."
  exit 1
fi

# Prompt for Email if not provided as argument
if [ -z "$EMAIL" ]; then
  read -rp "Enter your email for SSL alerts / Let's Encrypt: " EMAIL
fi

echo "[+] Updating package list and installing Nginx & Certbot..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y nginx certbot python3-certbot-nginx
elif command -v yum >/dev/null 2>&1; then
  yum install -y epel-release
  yum install -y nginx certbot python3-certbot-nginx
else
  echo "[-] Unsupported package manager. Please install Nginx and Certbot manually."
  exit 1
fi

NGINX_CONF="/etc/nginx/sites-available/stremio-torbox"
NGINX_LINK="/etc/nginx/sites-enabled/stremio-torbox"

# If sites-available doesn't exist (e.g. CentOS/RHEL/Fedora), fallback to conf.d
if [ ! -d "/etc/nginx/sites-available" ]; then
  NGINX_CONF="/etc/nginx/conf.d/stremio-torbox.conf"
  NGINX_LINK=""
fi

echo "[+] Creating Nginx configuration at $NGINX_CONF..."

cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_buffering off;
    }
}
EOF

# Enable site if using sites-enabled structure
if [ -n "$NGINX_LINK" ]; then
  mkdir -p /etc/nginx/sites-enabled
  ln -sf "$NGINX_CONF" "$NGINX_LINK"
  # Remove default configuration if present
  rm -f /etc/nginx/sites-enabled/default
fi

echo "[+] Testing Nginx configuration..."
nginx -t

echo "[+] Reloading Nginx..."
systemctl reload nginx || systemctl restart nginx

echo "[+] Obtaining SSL Certificate from Let's Encrypt..."
if [ -n "$EMAIL" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
else
  certbot --nginx -d "$DOMAIN" --redirect
fi

echo ""
echo "=============================================================================="
echo "✅ Setup Complete!"
echo "=============================================================================="
echo "Your Stremio-TorBox addon is live with HTTPS at:"
echo "👉 https://$DOMAIN/configure"
echo ""
echo "Stremio Install URL:"
echo "👉 stremio://$DOMAIN/manifest.json"
echo ""
echo "Make sure BASE_URL is set in your environment / docker-compose:"
echo "BASE_URL=https://$DOMAIN"
echo "=============================================================================="
