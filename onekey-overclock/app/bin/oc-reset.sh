#!/bin/bash
# OneKey-OC · 回滚恢复出厂（乖巧档，剥离所有超频痕迹）
# usage: oc-reset.sh [--reboot]
set +e
ENV=${ENVFILE:-/boot/fnEnv.txt}
OC=/boot/dtb/amlogic/meson-g12b-a311d-oes-oc.dtb
OC_MARK="fdtfile=amlogic/meson-g12b-a311d-oes-oc.dtb"
DEF_MARK="fdtfile=amlogic/meson-g12b-a311d-oes.dtb"
ARM=/boot/oc-arm

[ -f "$ENV" ] && {
    cp "$ENV" "/var/run/fnEnv.oc-reset.$(date +%s).bak" 2>/dev/null
    sed "s|$OC_MARK|$DEF_MARK|" "$ENV" > "$ENV.$$" 2>/dev/null
    if [ -s "$ENV.$$" ]; then
        sync; mv -f "$ENV.$$" "$ENV"; sync; chmod 644 "$ENV" 2>/dev/null
    else
        rm -f "$ENV.$$"
    fi
}
rm -f "$ARM" "$OC" 2>/dev/null
sync
for p in /sys/devices/system/cpu/cpufreq/policy*; do
    echo 2208000 > "$p/scaling_max_freq" 2>/dev/null
done
echo "OC_RESET_DONE"
if [ "$1" = "--reboot" ]; then
    sync
    reboot || /sbin/reboot
fi
exit 0