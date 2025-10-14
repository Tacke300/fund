#!/bin/bash
echo url="https://www.duckdns.org/update?domains=fundingbot&token=a1c170e9-fd2d-4112-85ad-cfd95ba0b34c&ip=" | curl -k -o /opt/duckdns/duck.log -K -
