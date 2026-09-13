#!/bin/bash
# OneKey-OC · 延迟干净重启
# 在系统完全就绪(multi-user)后执行一次 systemctl reboot，以加载已回滚的默认 DTB。
# 仅当早期 oc-health.sh 已写入 /run/oc-need-reboot 标记时才动作，且只执行一次。
LOG=/var/log/oc-selfheal.log
FLAG=/run/oc-need-reboot

[ -e "$FLAG" ] || { echo "[$(date '+%F %T')] oc-reboot: no pending flag" >> "$LOG"; exit 0; }

rm -f "$FLAG"; sync
echo "[$(date '+%F %T')] oc-reboot: clean reboot to load default freq" >> "$LOG"
sync
systemctl reboot
exit 0