#!/bin/bash

PROJECT_ID="$1"
START_NUM="$2"
ZONE="asia-southeast1-a"

for i in $(seq 0 7); do
  VPS_NUM=$(printf "%03d" $((10#$START_NUM + i)))
  INSTANCE_NAME="tung${VPS_NUM}"

  echo ">>> Tạo IP tĩnh $INSTANCE_NAME"
  gcloud compute addresses create "${INSTANCE_NAME}-ip" \
    --region="asia-southeast1" --project="$PROJECT_ID"

  IP_ADDR=$(gcloud compute addresses describe "${INSTANCE_NAME}-ip" \
    --region="asia-southeast1" \
    --format="get(address)" \
    --project="$PROJECT_ID")

  echo ">>> Tạo VPS $INSTANCE_NAME gắn IP $IP_ADDR"
  gcloud compute instances create "$INSTANCE_NAME" \
    --zone="$ZONE" \
    --machine-type="e2-micro" \
    --image-family=debian-11 \
    --image-project=debian-cloud \
    --address="$IP_ADDR" \
    --tags=http-server \
    --project="$PROJECT_ID" \
    --metadata=startup-script='#!/bin/bash
      apt update && apt install -y git screen python3-pip
      git clone https://github.com/youruser/yourbot.git
      cd yourbot && screen -dmS bot python3 run.py'
done
