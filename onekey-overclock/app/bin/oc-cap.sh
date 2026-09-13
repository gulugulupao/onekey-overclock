#!/bin/bash
# OneKey-OC · 开机按所选档位重设大核 scaling_max_freq（持久化频率上限）
#   配合自愈：OC DTB 下应用高档上限；若已被自愈回滚到默认 DTB，
#   写入的上限 > 默认 cpuinfo_max 会被内核自动钳制为默认，天然安全。
MODE_FILE=/usr/local/sbin/oc/oc-mode

BIGPOL=$(for p in /sys/devices/system/cpu/cpufreq/policy*; do
    f=$(cat "$p/cpuinfo_max_freq" 2>/dev/null);
    case "$f" in ''|*[!0-9]*) ;; *) echo "$f $p";; esac
done | sort -rn | head -1 | awk '{print $2}')
[ -n "$BIGPOL" ] || BIGPOL=/sys/devices/system/cpu/cpufreq/policy0

case "$(cat "$MODE_FILE" 2>/dev/null)" in
perf)  FRQ=2400000 ;;
beast) FRQ=2500000 ;;
*)     FRQ=2208000 ;;   # gentle / 未知 -> 最稳默认
esac

echo "$FRQ" > "$BIGPOL/scaling_max_freq" 2>/dev/null
echo "OC_CAP mode=$(cat "$MODE_FILE" 2>/dev/null) freq=$FRQ pol=$BIGPOL"
exit 0