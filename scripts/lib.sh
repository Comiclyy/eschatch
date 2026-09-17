# Shared logging helper for the netproxy scripts.
LOG_FILE="/Users/mbymax/Documents/code/networkingproxy/logs/netproxy.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}
