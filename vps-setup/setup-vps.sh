#!/usr/bin/env bash
# Run this ONCE on a fresh Oracle Cloud Free Tier Ubuntu VM, as a user with sudo
# (e.g. `ubuntu`). It creates a restricted, key-only user for the SOCKS5 tunnel
# and makes sshd also listen on 443 so the connection blends in with normal
# HTTPS traffic on networks that block SSH's usual port 22.
#
# Usage: sudo ./setup-vps.sh "ssh-ed25519 AAAA...escapehatch-vps-tunnel"
set -euo pipefail

PUBKEY="${1:-}"
if [[ -z "$PUBKEY" ]]; then
  echo "Usage: sudo $0 \"<public-key-contents>\"" >&2
  exit 1
fi

TUNNEL_USER="tunnel"

if ! id "$TUNNEL_USER" &>/dev/null; then
  useradd --create-home --shell /usr/sbin/nologin "$TUNNEL_USER"
fi

install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "/home/$TUNNEL_USER/.ssh"
echo "$PUBKEY" > "/home/$TUNNEL_USER/.ssh/authorized_keys"
chown "$TUNNEL_USER:$TUNNEL_USER" "/home/$TUNNEL_USER/.ssh/authorized_keys"
chmod 600 "/home/$TUNNEL_USER/.ssh/authorized_keys"

SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "$SSHD_CONFIG.bak.$(date +%s)"

# Listen on both the normal port and 443, so the tunnel can fall back to
# whichever one the network doesn't block.
if ! grep -qE '^Port 443$' "$SSHD_CONFIG"; then
  echo "Port 22" >> "$SSHD_CONFIG"
  echo "Port 443" >> "$SSHD_CONFIG"
fi

# Restrict the tunnel user: no shell, no X11, no real login — just forwarding.
if ! grep -q "Match User $TUNNEL_USER" "$SSHD_CONFIG"; then
  cat >> "$SSHD_CONFIG" <<EOF

Match User $TUNNEL_USER
    AllowTcpForwarding yes
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
    PermitTTY no
    AllowAgentForwarding no
EOF
fi

sshd -t   # validate config before restarting; aborts (set -e) if invalid
systemctl restart sshd

# Open 443 on the host firewall. Oracle's Ubuntu images ship with iptables
# rules (not ufw) restricting inbound traffic by default.
if command -v iptables &>/dev/null; then
  iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  netfilter-persistent save 2>/dev/null || iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
fi
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 443/tcp
fi

echo
echo "Done. sshd is listening on 22 and 443."
echo "IMPORTANT: You still need to open port 443 (TCP, ingress) in the Oracle"
echo "Cloud console's VCN Security List / Network Security Group for this"
echo "instance's subnet — the host firewall alone is not enough on OCI."
echo
echo "Test the tunnel from your laptop with:"
echo "  ssh -D 1080 -N -p 443 -i ~/.ssh/id_ed25519_escapehatch $TUNNEL_USER@<VPS_PUBLIC_IP>"
