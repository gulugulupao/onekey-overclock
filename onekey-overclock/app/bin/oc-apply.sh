#!/bin/bash
# OneKey-OC · 应用档位到持久层（DTB + fnEnv + OPP 曲线）
# usage: oc-apply.sh <gentle|perf|beast> [--noreboot]
#   以 root 运行（fnOS 以 root 启动本应用）。不负责修改 settings.json（由 web 端写入）。
#   v2: 所有持久化写入(fnEnv/DTB)一律原子写(temp + fsync + mv)，杜绝写坏变砖。
set +e
VAR="${VAR:-/vol1/@appdata/onekey-overclock}"
ENV=/boot/fnEnv.txt
BASE=/boot/dtb/amlogic/meson-g12b-a311d-oes.dtb
OC=/boot/dtb/amlogic/meson-g12b-a311d-oes-oc.dtb
OC_MARK="fdtfile=amlogic/meson-g12b-a311d-oes-oc.dtb"
DEF_MARK="fdtfile=amlogic/meson-g12b-a311d-oes.dtb"
ARM=/boot/oc-arm
TMP="$VAR/burn"
MODE="$1"
NO_REBOOT="$2"
mkdir -p "$TMP"

# --- 大核 A73 集群策略 policy：cpuinfo_max_freq 最大者为 A73（big） ---
BIGPOL=$(for p in /sys/devices/system/cpu/cpufreq/policy*; do
    f=$(cat "$p/cpuinfo_max_freq" 2>/dev/null);
    case "$f" in ''|*[!0-9]*) ;; *) echo "$f $p";; esac
done | sort -rn | head -1 | awk '{print $2}')
[ -n "$BIGPOL" ] || BIGPOL=/sys/devices/system/cpu/cpufreq/policy0

case "$MODE" in
gentle) FREQ=2208000; WANT_OC=0 ;;
perf)   FREQ=2400000; WANT_OC=1 ;;
beast)  FREQ=2500000; WANT_OC=1 ;;
*)
    echo "ERR: bad mode $MODE"; exit 2 ;;
esac

# 持久化所选档位延后到"应用成功"之后（见文件末尾）：避免 DTB 生成/校验失败时档位与实际不符

# --- 生成/校验合并超频 DTB（须同时含 2.4+2.5 OPP，缺任一个则重建；原子写） ---
if [ "$WANT_OC" = "1" ]; then
    need=1
    if [ -f "$OC" ]; then
        if command -v fdtget >/dev/null 2>&1 \
           && fdtget "$OC" /opp-table-1/opp-2400000000 opp-hz >/dev/null 2>&1 \
           && fdtget "$OC" /opp-table-1/opp-2500000000 opp-hz >/dev/null 2>&1; then
            need=0
        fi
    fi
    if [ "$need" = 1 ]; then
        if ! command -v dtc >/dev/null 2>&1 || ! command -v fdtoverlay >/dev/null 2>&1; then
            echo "ERR: dtc/fdtoverlay missing"; exit 3
        fi
        [ -f "$BASE" ] || { echo "ERR: base dtb missing $BASE"; exit 3; }
        rm -f "$OC"
        cat > "$TMP/oc-combined.dts" <<'DTS'
/dts-v1/;
/plugin/;
/ {
    fragment@0 {
        target-path = "/opp-table-1";
        __overlay__ {
            opp-2400000000 { opp-hz = <0x00 0x8f0d1800>; opp-microvolt = <0x0fb770>; clock-latency-ns = <0xc350>; };
            opp-2500000000 { opp-hz = <0x00 0x9502f900>; opp-microvolt = <0xfde80>; clock-latency-ns = <0xc350>; };
        };
    };
};
DTS
        dtc -@ -I dts -O dtb -o "$TMP/oc.dtbo" "$TMP/oc-combined.dts" || { echo "ERR dtc"; exit 3; }
        fdtoverlay -i "$BASE" -o "$OC.$$" "$TMP/oc.dtbo" || { rm -f "$OC.$$"; echo "ERR fdtoverlay"; exit 3; }
        sync
        mv -f "$OC.$$" "$OC"          # 原子落位
        sync
        echo "OC_DTB_GEN_OK"
    else
        echo "OC_DTB_OK (both opps present)"
    fi
fi

# --- 写 scaling_max_freq（若当前加载的 OPP 表包含该档则即时生效） ---
if [ -d "$BIGPOL" ]; then
    echo "$FREQ" > "$BIGPOL/scaling_max_freq" 2>/dev/null
    echo "SCALING_MAX=$FREQ bigpol=$BIGPOL"
fi

# --- fnEnv + arm 许可（持久化，原子写） ---
if [ -f "$ENV" ]; then
    if [ "$WANT_OC" = "1" ] && [ -f "$OC" ]; then
        cp "$ENV" "/var/run/fnEnv.oc-apply.$(date +%s).bak" 2>/dev/null
        if ! grep -q "$OC_MARK" "$ENV"; then
            # 原子替换：sed 到临时文件，校验后 mv
            sed -e "s|fdtfile=.*|$OC_MARK|" "$ENV" > "$ENV.$$" 2>/dev/null
            [ -s "$ENV.$$" ] && { sync; mv -f "$ENV.$$" "$ENV"; sync; chmod 644 "$ENV" 2>/dev/null; }
        fi
        grep -q "fdtfile=" "$ENV" || echo "$OC_MARK" >> "$ENV"
        touch "$ARM"; sync
        echo "OC_ARMED"
    else
        cp "$ENV" "/var/run/fnEnv.oc-gentle.$(date +%s).bak" 2>/dev/null
        sed "s|$OC_MARK|$DEF_MARK|" "$ENV" > "$ENV.$$" 2>/dev/null
        [ -s "$ENV.$$" ] && { sync; mv -f "$ENV.$$" "$ENV"; sync; chmod 644 "$ENV" 2>/dev/null; }
        rm -f "$ARM"; sync
        echo "OC_DEFAULTED"
    fi
fi

# --- 应用成功后再持久化所选档位到根分区（供开机 oc-cap 服务读取，跨重启可读、不受 /vol1 延迟挂载影响） ---
mkdir -p /usr/local/sbin/oc
echo "$MODE" > /usr/local/sbin/oc/oc-mode
sync

# --- 若需要重启生效且未禁用，则重启 ---
if [ "$WANT_OC" = "1" ] && [ "$NO_REBOOT" != "--noreboot" ]; then
    echo "REBOOTING to load $MODE..."
    sync
    reboot || /sbin/reboot
fi
exit 0