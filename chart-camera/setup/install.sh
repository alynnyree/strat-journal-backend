#!/usr/bin/env bash
# THE CHART CAMERA'S ONE-TIME SET-UP, run on the Raspberry Pi itself from
# the folder the software was downloaded into:
#
#   bash chart-camera/setup/install.sh            (everything except the drive)
#   bash chart-camera/setup/install.sh --format-ssd
#
# --format-ssd prepares the SSD for recordings. It ONLY touches a drive
# that is completely blank (brand new); a drive with anything on it is left
# alone and the script says so. Safe to run again: it skips what is done.
set -euo pipefail

CAM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$CAM/.." && pwd)"
ME="$(id -un)"
say() { printf '\n== %s\n' "$*"; }

say "Installing the programs the camera needs (this takes a few minutes)"
sudo apt-get update -y
sudo apt-get install -y ffmpeg xvfb x11vnc nodejs npm git fonts-dejavu-core
if apt-cache show chromium >/dev/null 2>&1; then sudo apt-get install -y chromium; else sudo apt-get install -y chromium-browser; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "STOPPED: this Pi has Node $NODE_MAJOR; the camera needs 18 or newer."; exit 1; fi

say "Installing the camera's browser-control part"
npm --prefix "$CAM" install --omit=dev --no-audit --no-fund

if [ "${1:-}" = "--format-ssd" ]; then
  say "Preparing the SSD for recordings"
  DEV=/dev/nvme0n1
  if [ ! -b "$DEV" ]; then
    echo "No SSD was found at $DEV. Is the SSD kit fitted? Nothing was changed."; exit 1
  fi
  if sudo blkid -L chartcam >/dev/null 2>&1; then
    echo "The SSD is already prepared for the camera; it is left as it is."
  else
    PARTS="$(lsblk -nr -o NAME "$DEV" | wc -l)"
    FSTYPE="$(lsblk -nr -o FSTYPE "$DEV" | head -1)"
    if [ "$PARTS" -ne 1 ] || [ -n "$FSTYPE" ]; then
      echo "STOPPED: the SSD at $DEV is not blank (it has something on it), so it was NOT erased."
      echo "If you are sure it holds nothing you need, tell Claude, who will give you the exact next step."
      exit 1
    fi
    sudo mkfs.ext4 -F -L chartcam "$DEV"
  fi
  sudo mkdir -p /mnt/ssd
  if ! grep -q 'LABEL=chartcam' /etc/fstab; then
    echo 'LABEL=chartcam /mnt/ssd ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab >/dev/null
  fi
  sudo systemctl daemon-reload
  sudo mount -a
  sudo mkdir -p /mnt/ssd/chart-camera
  sudo chown "$ME":"$ME" /mnt/ssd/chart-camera
  echo "The SSD is ready at /mnt/ssd ($(df -h /mnt/ssd | awk 'NR==2{print $4}') free)."
fi

say "Putting the settings file in place"
sudo mkdir -p /etc/chart-camera
if [ ! -f /etc/chart-camera/config.json ]; then
  sudo cp "$CAM/setup/config.example.json" /etc/chart-camera/config.json
  echo "A settings file was created; it still needs your details (see the guide)."
else
  echo "Your settings file is already there; it is left as it is."
fi
sudo chown "$ME":"$ME" /etc/chart-camera/config.json
chmod 600 /etc/chart-camera/config.json   # only this user can read it: it holds the app key

say "Setting the camera to start by itself whenever the Pi is switched on"
for unit in chart-camera-display.service chart-camera.service chart-camera-vnc.service chart-camera-update.service chart-camera-update.timer; do
  sed -e "s#__USER__#$ME#g" -e "s#__CAM__#$CAM#g" -e "s#__REPO__#$REPO#g" "$CAM/setup/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable chart-camera-display.service chart-camera.service chart-camera-update.timer

say "Done"
echo "Next: fill in /etc/chart-camera/config.json, sign in to TradingView once, then start the camera (see the guide)."
