#!/bin/bash
echo "Updating DuckDNS..."
IP=$(curl -s ifconfig.me)
curl -s "https://www.duckdns.org/update?domains=fundingbot&token=a1c170e9-fd2d-4112-85ad-cfd95ba0b34c&ip=$IP" -o duck.log
echo "Done. Log saved to duck.log"
