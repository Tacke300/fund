#!/bin/bash

BILLING_ACCOUNT_ID="01A1B2-C3D4E5-6789F0"

for START_NUM in $(seq -w 3 8 298); do
  PROJECT_ID="tung${START_NUM}-group"
  echo ">>> Tạo project: $PROJECT_ID"

  gcloud projects create "$PROJECT_ID" --name="$PROJECT_ID"
  gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT_ID"
  gcloud config set project "$PROJECT_ID"
  gcloud services enable compute.googleapis.com

  echo ">>> Tạo VPS từ tung${START_NUM} tới tung$((START_NUM+7))"
  bash ./create_vps_batch.sh "$PROJECT_ID" "$START_NUM"

  echo "=============================="
done
