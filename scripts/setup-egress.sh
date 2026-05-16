#!/usr/bin/env bash
# PRO-34: Network egress policy setup for execution containers.
# Applied via docker exec as root before the job process starts.
#
# Usage (inside container):
#   setup-egress.sh <dns_server1> [dns_server2 ...] -- <cidr1> [cidr2 ...]
#
# Environment variables:
#   PAPERCLIP_DNS_SERVERS   Comma-separated DNS server list
#   PAPERCLIP_ALLOWED_CIDRS Comma-separated allowed CIDR list
#   PAPERCLIP_IPTABLES_BIN  Path to iptables binary (default: iptables)

set -euo pipefail

IPTABLES="${PAPERCLIP_IPTABLES_BIN:-iptables}"

# ---------------------------------------------------------------------------
# Parse arguments: DNS servers before --, CIDRs after --
# ---------------------------------------------------------------------------
DNS_SERVERS=()
ALLOWED_CIDRS=()

MODE="dns"
for arg in "$@"; do
    if [ "$arg" = "--" ]; then
        MODE="cidr"
        continue
    fi
    if [ "$MODE" = "dns" ]; then
        DNS_SERVERS+=("$arg")
    else
        ALLOWED_CIDRS+=("$arg")
    fi
done

# Fall back to env vars if no CLI args
if [ ${#DNS_SERVERS[@]} -eq 0 ] && [ -n "${PAPERCLIP_DNS_SERVERS:-}" ]; then
    IFS=',' read -ra DNS_SERVERS <<< "$PAPERCLIP_DNS_SERVERS"
fi
if [ ${#ALLOWED_CIDRS[@]} -eq 0 ] && [ -n "${PAPERCLIP_ALLOWED_CIDRS:-}" ]; then
    IFS=',' read -ra ALLOWED_CIDRS <<< "$PAPERCLIP_ALLOWED_CIDRS"
fi

# ---------------------------------------------------------------------------
# Check for iptables availability (try iptables, then iptables-legacy)
# ---------------------------------------------------------------------------
if ! command -v "$IPTABLES" &>/dev/null; then
    if command -v iptables-legacy &>/dev/null; then
        IPTABLES="iptables-legacy"
    elif command -v iptables-nft &>/dev/null; then
        IPTABLES="iptables-nft"
    else
        echo "ERROR: No iptables binary found" >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Apply egress rules
# ---------------------------------------------------------------------------

echo "[egress] Flushing OUTPUT chain..."
$IPTABLES -F OUTPUT 2>/dev/null || true

echo "[egress] Setting default policy: DROP outbound..."
$IPTABLES -P OUTPUT DROP

echo "[egress] Allowing loopback..."
$IPTABLES -A OUTPUT -o lo -j ACCEPT

# Allow established/related for return traffic
if $IPTABLES -L INPUT -n &>/dev/null; then
    $IPTABLES -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
    $IPTABLES -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
fi

# DNS — only approved servers
if [ ${#DNS_SERVERS[@]} -gt 0 ]; then
    echo "[egress] Restricting DNS to: ${DNS_SERVERS[*]}"
    for dns in "${DNS_SERVERS[@]}"; do
        $IPTABLES -A OUTPUT -p udp --dport 53 -d "$dns" -j ACCEPT
        $IPTABLES -A OUTPUT -p tcp --dport 53 -d "$dns" -j ACCEPT
    done
else
    echo "[egress] WARNING: No DNS servers configured — DNS resolution will fail"
fi

# Allowed CIDRs
if [ ${#ALLOWED_CIDRS[@]} -gt 0 ]; then
    for cidr in "${ALLOWED_CIDRS[@]}"; do
        if [ "$cidr" = "0.0.0.0/0" ]; then
            echo "[egress] Allow-all CIDR detected — setting default ACCEPT"
            $IPTABLES -P OUTPUT ACCEPT
            break
        fi
        echo "[egress] Allowing outbound to: $cidr"
        $IPTABLES -A OUTPUT -d "$cidr" -j ACCEPT
    done
else
    echo "[egress] No CIDRs allowed — all outbound blocked"
fi

# Verify policy is in place
POLICY=$($IPTABLES -L OUTPUT -n 2>/dev/null | head -1 | grep -o 'DROP\|ACCEPT' || echo "UNKNOWN")
echo "[egress] OUTPUT policy: $POLICY — setup complete"

# Log rules for audit
if [ "${PAPERCLIP_EGRESS_VERBOSE:-0}" = "1" ]; then
    echo "[egress] --- Current OUTPUT rules ---"
    $IPTABLES -L OUTPUT -n -v 2>/dev/null || true
    echo "[egress] --- End of rules ---"
fi

exit 0
