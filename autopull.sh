#!/bin/bash

echo "===== BẮT ĐẦU DEPLOY ====="

cd /home/tacke300/tz800 || {
  echo "[LỖI] Không vào được thư mục dự án!"
  exit 1
}

echo "[B1] Đã vào thư mục dự án."

# Nếu đang kẹt trong quá trình rebase
if [ -d ".git/rebase-merge" ]; then
  echo "[!] Đang kẹt trong rebase, sẽ abort..."
  git rebase --abort
fi

echo "[B2] Đang reset local code về HEAD..."
git reset --hard HEAD && echo "[B2] Reset thành công." || {
  echo "[LỖI] Không thể reset code!"
  exit 1
}

echo "[B3] Đang thực hiện git pull --rebase origin main..."
git pull --rebase origin main && echo "[B3] Pull thành công." || {
  echo "[B3] Lỗi khi pull từ git!"
  exit 1
}

# Copy souce code vào folder nginx
cp -r . /var/www/html/tz800
ls -al /var/www/html/tz800

echo "===== DEPLOY THÀNH CÔNG ====="
