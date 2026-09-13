#!/bin/bash
# OneKey-OC · 自愈回滚 v2
#  持久许可：/boot/fnEnv.txt(指向OC DTB) + /boot/oc-arm(一次性许可)
#  任意未授权重启(手动/宕机/断电)后，本服务在启动早期把 fnEnv 原子回滚到默认 DTB。
#  本阶段【绝不 reboot】——重启交给 oc-reboot.service（系统就绪后执行一次），
#  避免 systemd 未就绪时调用 reboot 造成挂死/复位循环。
LOG=/var/log/oc-selfheal.log
ENV=/boot/fnEnv.txt
OC_MARK="fdtfile=amlogic/meson-g12b-a311d-oes-oc.dtb"
DEF_MARK="fdtfile=amlogic/meson-g12b-a311d-oes.dtb"
ARM=/boot/oc-arm
FLAG=/run/oc-need-reboot

log(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 未指向超频 DTB -> 正常启动，无事发生
grep -q "$OC_MARK" "$ENV" 2>/dev/null || { log "normal boot (not OC)"; exit 0; }

# 本次开机被 arm（有许可）：允许超频，消费许可
if [ -f "$ARM" ]; then
    rm -f "$ARM"; sync
    log "armed boot: OC enabled this boot (permit consumed)"
    exit 0
fi

# 未授权重启：原子回滚 fnEnv 到默认 DTB，标记稍后干净重启
log "un-armed reboot -> atomic revert fnEnv to default"
cp -f "$ENV" "/var/run/fnEnv.failover.$(date +%s).bak" 2>/dev/null
sed "s|$OC_MARK|$DEF_MARK|" "$ENV" > "$ENV.$$" 2>/dev/null
if [ -s "$ENV.$$" ]; then
    sync
    mv -f "$ENV.$$" "$ENV"
    sync
    chmod 644 "$ENV" 2>/dev/null
    # 同步把档位回退到最稳默认，保证开机 oc-cap 上限与回滚后的 DTB 一致
    echo "gentle" > /usr/local/sbin/oc/oc-mode 2>/dev/null
    sync
    touch "$FLAG"
    log "fnEnv reverted atomically; reboot deferred to oc-reboot.service (mode->gentle)"
else
    rm -f "$ENV.$$"
    log "WARN: sed produced empty/zero file, keeping original (no change)"
fi
exit 0