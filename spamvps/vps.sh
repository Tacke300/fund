#!/bin/bash

BILLING_ACCOUNT_ID="01CB27-C17A15-0CE7B8"
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
  gcloud compute addresses create "$ip_name" --region="$REGION" --project="$project_id" 2>/dev/null
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

curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs
npm install -g pm2

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

function delete_instance_if_exists() {
  local project_id="$1"
  local instance_name="$2"
  if gcloud compute instances list --filter="name=$instance_name" --project="$project_id" --format="get(name)" | grep -q "$instance_name"; then
    echo "⚠️ Xóa VPS cũ $instance_name trước khi tạo lại"
    gcloud compute instances delete "$instance_name" --zone="$ZONE" --project="$project_id" --quiet
  fi
}

# ==== Main ====

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <start_num> <end_num>"
  echo "Ví dụ: $0 1 300"
  exit 1
fi

START_NUM="$1"
END_NUM="$2"

for (( num=START_NUM; num<=END_NUM; num+=4 )); do
  START_BATCH_NUM=$num
  PROJECT_ID="tung$(printf "%03d" "$START_BATCH_NUM")-group"

  echo "=== Đang xử lý project: $PROJECT_ID ==="

  if check_project_exists "$PROJECT_ID"; then
    echo "Project $PROJECT_ID đã tồn tại, bỏ qua bước tạo"
  else
    echo "Tạo mới project $PROJECT_ID"
    gcloud projects create "$PROJECT_ID" --name="$PROJECT_ID"
    gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
    gcloud config set project "$PROJECT_ID"
    gcloud services enable compute.googleapis.com
    sleep 15
  fi

  gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID" 2>/dev/null || true
  gcloud services enable compute.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true

  for i in $(seq 0 3); do
    VPS_NUM=$(printf "%03d" $((10#$START_BATCH_NUM + i)))
    INSTANCE_NAME="tung${VPS_NUM}"
    IP_NAME="${INSTANCE_NAME}-ip"

    echo ">>> Kiểm tra/gán IP cho $INSTANCE_NAME"
    if ! gcloud compute addresses list --filter="name=$IP_NAME AND region=$REGION" --format="get(name)" --project="$PROJECT_ID" | grep -q "$IP_NAME"; then
      create_static_ip "$PROJECT_ID" "$IP_NAME"
    fi

    IP_ADDR=$(get_static_ip "$PROJECT_ID" "$IP_NAME")
    [[ -z "$IP_ADDR" ]] && echo "❌ Không lấy được IP $IP_NAME, bỏ qua VPS $INSTANCE_NAME" && continue

    delete_instance_if_exists "$PROJECT_ID" "$INSTANCE_NAME"
    echo ">>> Tạo lại VPS $INSTANCE_NAME"
    create_vps_instance "$PROJECT_ID" "$INSTANCE_NAME" "$IP_ADDR"
  done

  echo "✅ Xong project $PROJECT_ID"
done

echo "🎉 Hoàn tất tạo hàng loạt VPS!"
