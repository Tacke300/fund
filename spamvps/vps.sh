#!/bin/bash

BILLING_ACCOUNT_ID="01A1B2-C3D4E5-6789F0"
ZONE="asia-southeast1-a"
REGION="asia-southeast1"

# Hàm kiểm tra project đã tồn tại chưa
function check_project_exists() {
  local project_id="$1"
  gcloud projects describe "$project_id" &>/dev/null
  return $?
}

# Hàm tạo IP tĩnh, retry nếu lỗi
function create_static_ip() {
  local project_id="$1"
  local ip_name="$2"
  local max_retry=5
  local retry=0

  while (( retry < max_retry )); do
    echo "Tạo IP tĩnh $ip_name (attempt $((retry+1)))"
    if gcloud compute addresses create "$ip_name" --region="$REGION" --project="$project_id" 2>/dev/null; then
      return 0
    else
      echo "Lỗi tạo IP tĩnh, đợi 5s rồi thử lại..."
      sleep 5
      ((retry++))
    fi
  done

  echo "Tạo IP tĩnh $ip_name thất bại sau $max_retry lần"
  return 1
}

# Hàm lấy IP tĩnh
function get_static_ip() {
  local project_id="$1"
  local ip_name="$2"
  gcloud compute addresses describe "$ip_name" --region="$REGION" --format="get(address)" --project="$project_id"
}

# Hàm tạo VPS, retry nếu lỗi
function create_vps_instance() {
  local project_id="$1"
  local instance_name="$2"
  local ip_addr="$3"

  local max_retry=3
  local retry=0

  while (( retry < max_retry )); do
    echo "Tạo VPS $instance_name gắn IP $ip_addr (attempt $((retry+1)))"
    if gcloud compute instances create "$instance_name" \
      --zone="$ZONE" \
      --machine-type="e2-micro" \
      --image-family=debian-11 \
      --image-project=debian-cloud \
      --address="$ip_addr" \
      --tags=http-server \
      --project="$project_id" \
      --metadata=startup-script='#!/bin/bash
        apt update && apt install -y git screen python3-pip
        git clone https://github.com/youruser/yourbot.git
        cd yourbot && screen -dmS bot python3 run.py'
    then
      return 0
    else
      echo "Lỗi tạo VPS, đợi 5s rồi thử lại..."
      sleep 5
      ((retry++))
    fi
  done

  echo "Tạo VPS $instance_name thất bại sau $max_retry lần"
  return 1
}

# Bắt đầu script chính

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

  echo "=================================================="
  echo "Xử lý project: $PROJECT_ID"

  if check_project_exists "$PROJECT_ID"; then
    echo "Project $PROJECT_ID đã tồn tại, bỏ qua tạo mới"
  else
    echo "Tạo project $PROJECT_ID"
    gcloud projects create "$PROJECT_ID" --name="$PROJECT_ID" || { echo "Tạo project thất bại"; continue; }

    echo "Link billing cho project $PROJECT_ID"
    gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID" || { echo "Link billing thất bại"; continue; }

    echo "Enable Compute Engine API cho project $PROJECT_ID"
    gcloud services enable compute.googleapis.com --project="$PROJECT_ID" || { echo "Enable API thất bại"; continue; }

    echo "Đợi 15 giây để project sẵn sàng"
    sleep 15
  fi

  echo "Bắt đầu tạo VPS từ tung$(printf "%03d" "$START_BATCH_NUM") tới tung$(printf "%03d" $((START_BATCH_NUM+7)))"

  for i in $(seq 0 7); do
    VPS_NUM=$(printf "%03d" $((10#$START_BATCH_NUM + i)))
    INSTANCE_NAME="tung${VPS_NUM}"
    IP_NAME="${INSTANCE_NAME}-ip"

    # Tạo IP tĩnh (nếu chưa có)
    IP_EXISTS=$(gcloud compute addresses list --filter="name=$IP_NAME AND region=$REGION" --format="get(name)" --project="$PROJECT_ID")
    if [[ "$IP_EXISTS" == "$IP_NAME" ]]; then
      echo "IP tĩnh $IP_NAME đã tồn tại"
    else
      create_static_ip "$PROJECT_ID" "$IP_NAME" || { echo "Bỏ VPS $INSTANCE_NAME do lỗi tạo IP"; continue; }
    fi

    # Lấy IP tĩnh
    IP_ADDR=$(get_static_ip "$PROJECT_ID" "$IP_NAME")
    if [[ -z "$IP_ADDR" ]]; then
      echo "Không lấy được IP tĩnh cho $IP_NAME, bỏ VPS $INSTANCE_NAME"
      continue
    fi

    # Kiểm tra VPS đã tồn tại chưa
    VPS_EXISTS=$(gcloud compute instances list --filter="name=$INSTANCE_NAME" --zones="$ZONE" --format="get(name)" --project="$PROJECT_ID")
    if [[ "$VPS_EXISTS" == "$INSTANCE_NAME" ]]; then
      echo "VPS $INSTANCE_NAME đã tồn tại, bỏ qua tạo mới"
      continue
    fi

    # Tạo VPS
    create_vps_instance "$PROJECT_ID" "$INSTANCE_NAME" "$IP_ADDR" || echo "Tạo VPS $INSTANCE_NAME thất bại"
  done

  echo "=================================================="
done

echo "Hoàn tất toàn bộ quá trình!"
