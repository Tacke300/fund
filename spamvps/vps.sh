#!/bin/bash

BILLING_ACCOUNT_ID="01A1B2-C3D4E5-6789F0"
ZONE="asia-southeast1-a"
REGION="asia-southeast1"

function check_project_exists() {
  local project_id="$1"
  gcloud projects describe "$project_id" &>/dev/null
  return $?
}

function create_static_ip() {
  local project_id="$1"
  local ip_name="$2"
  local retry=0
  while (( retry < 5 )); do
    if gcloud compute addresses create "$ip_name" --region="$REGION" --project="$project_id" 2>/dev/null; then
      return 0
    else
      echo "Retry tạo IP tĩnh $ip_name..."
      sleep 5
      ((retry++))
    fi
  done
  return 1
}

function get_static_ip() {
  local project_id="$1"
  local ip_name="$2"
  gcloud compute addresses describe "$ip_name" --region="$REGION" --format="get(address)" --project="$project_id"
}

function create_vps_instance() {
  local project_id="$1"
  local instance_name="$2"
  local ip_addr="$3"

  local startup_script=$(cat <<'EOF'
#!/bin/bash
timedatectl set-timezone UTC
apt update && apt install -y curl git screen python3-pip

# Cài đặt Node.js v18 (LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# Cài đặt PM2
npm install -g pm2

# Clone bot về và cài đặt
git clone https://github.com/tacke300/fundingbotpromax.git
cd fundingbotpromax
npm install

npm install express ws

EOF
)

  gcloud compute instances create "$instance_name" \
    --zone="$ZONE" \
    --machine-type="e2-micro" \
    --image-family=debian-11 \
    --image-project=debian-cloud \
    --address="$ip_addr" \
    --tags=http-server \
    --project="$project_id" \
    --metadata startup-script="$startup_script"
}

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <start_num> <end_num>"
  echo "Ví dụ: $0 3 298"
  exit 1
fi

START_NUM="$1"
END_NUM="$2"

for (( num=START_NUM; num<=END_NUM; num+=8 )); do
  START_BATCH_NUM=$num
  PROJECT_ID="tung$(printf "%03d" "$START_BATCH_NUM")-group"

  echo "=== Đang xử lý project: $PROJECT_ID ==="

  if check_project_exists "$PROJECT_ID"; then
    echo "Project $PROJECT_ID đã tồn tại, bỏ qua"
  else
    echo "Tạo mới project $PROJECT_ID"
    gcloud projects create "$PROJECT_ID" --name="$PROJECT_ID"
    gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
    gcloud config set project "$PROJECT_ID"
    gcloud services enable compute.googleapis.com
    sleep 15
  fi

  for i in $(seq 0 7); do
    VPS_NUM=$(printf "%03d" $((10#$START_BATCH_NUM + i)))
    INSTANCE_NAME="tung${VPS_NUM}"
    IP_NAME="${INSTANCE_NAME}-ip"

    echo ">>> Kiểm tra/gán IP cho $INSTANCE_NAME"
    if ! gcloud compute addresses list --filter="name=$IP_NAME AND region=$REGION" --format="get(name)" --project="$PROJECT_ID" | grep -q "$IP_NAME"; then
      create_static_ip "$PROJECT_ID" "$IP_NAME" || continue
    fi

    IP_ADDR=$(get_static_ip "$PROJECT_ID" "$IP_NAME")
    [[ -z "$IP_ADDR" ]] && echo "Không lấy được IP $IP_NAME" && continue

    echo ">>> Tạo VPS $INSTANCE_NAME"
    if ! gcloud compute instances list --filter="name=$INSTANCE_NAME" --zones="$ZONE" --format="get(name)" --project="$PROJECT_ID" | grep -q "$INSTANCE_NAME"; then
      create_vps_instance "$PROJECT_ID" "$INSTANCE_NAME" "$IP_ADDR"
    else
      echo ">>> VPS $INSTANCE_NAME đã tồn tại"
    fi
  done

  echo "=== Xong project $PROJECT_ID ==="
done

echo "🎉 Hoàn tất tạo hàng loạt VPS!"
