#!/bin/bash
# OneKey-OC · 硬件看门狗门禁（arm / disarm / status）
# 判定"已启用"看门狗：/sys 设备 state==active（正在被喂）或 systemd RuntimeWatchdogSec
# 已配置（覆盖后续每次开机）。两条任一成立即放行超频档。
set +e
PIDF=/tmp/oc-wd-loop.pid
SENT=/run/oc-wd-feeding        # arm 时落盘的可勾连哨兵（tmpfs，重启后会消失）
SYS=/etc/systemd/system.conf

_wd_active () {
    local s
    s=$(cat /sys/class/watchdog/watchdog0/state 2>/dev/null)
    [ "$s" = "active" ]
}

arm () {
    # 若设备上无喂狗循环则启动之；命令行带 /dev/watchdog 便于对账
    if ! _wd_active && [ ! -e /dev/watchdog ]; then
        echo "WD_NO_DEV"
        return 1
    fi
    if ! _wd_active; then
        nohup sh -c 'while :; do echo dock > /dev/watchdog 2>/dev/null; sleep 4; done' </dev/null >/dev/null 2>&1 &
        echo $! > "$PIDF"
        sleep 1
    fi
    # systemd 开机喂狗（覆盖后续每次开机）
    if ! grep -q '^RuntimeWatchdogSec=' "$SYS" 2>/dev/null; then
        echo 'RuntimeWatchdogSec=12' >> "$SYS"
        systemctl daemon-reload 2>/dev/null
    fi
    echo "" > "$SENT" 2>/dev/null
    echo "WD_ARMED"
}

disarm () {
    [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null
    pkill -f 'while :; do echo dock > /dev/watchdog' 2>/dev/null
    rm -f "$PIDF" "$SENT"
    # 撤销"开机喂狗"：删除持久化的 RuntimeWatchdogSec，否则下次开机 systemd 仍会 re-arm（历史复位元凶）
    if grep -q '^RuntimeWatchdogSec=' "$SYS" 2>/dev/null; then
        sed '/^RuntimeWatchdogSec=.*/d' "$SYS" > "$SYS.$$" 2>/dev/null
        if [ -s "$SYS.$$" ]; then
            sync; mv -f "$SYS.$$" "$SYS"; sync
            systemctl daemon-reload 2>/dev/null
        else
            rm -f "$SYS.$$"
        fi
    fi
    echo "WD_DISARMED"
}

status () {
    local act=0
    _wd_active && act=1
    local sysw=0
    grep -q '^RuntimeWatchdogSec=' "$SYS" 2>/dev/null && sysw=1
    local dev=0
    [ -e /dev/watchdog ] && dev=1
    # 是否允许超频：看门狗正被喂 或 已配置开机喂狗
    local en=0
    [ "$act" = 1 ] || [ "$sysw" = 1 ] && en=1
    echo "WD_ACTIVE=$act SYS_WD=$sysw DEV=$dev WD_ENABLED=$en"
}

case "$1" in
arm) arm ;;
disarm) disarm ;;
*) status ;;
esac
exit 0