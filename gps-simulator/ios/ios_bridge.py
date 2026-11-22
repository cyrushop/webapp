#!/usr/bin/env python3
"""
iPhone location bridge (iOS 17.4+), driven by the Node bridge over stdin/stdout.

  stdin  (JSON lines): {"t":"fix","lat":..,"lng":..}   {"t":"clear"}
  stdout (JSON lines): {"t":"status","state":"connecting|mounting|ready|error", ...}
                       {"t":"hello","udid":..,"model":..,"ios":..}
                       {"t":"ack","fixes":N}

Uses pymobiledevice3's no-root userspace tunnel (UserspaceRsdTunnel), so no sudo/tunneld is
needed. The simulated location only lasts while this process keeps its DVT session open; on exit
it clears the simulation and the iPhone returns to its real GPS.

Tested against the pymobiledevice3 11.x async API (UserspaceRsdTunnel, DvtProvider,
LocationSimulation). Requires: Developer Mode on, iPhone unlocked and "Trust This Computer".
"""

import asyncio
import json
import os
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def status(state, **extra):
    emit({"t": "status", "state": state, **extra})


async def stdin_lines():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            return
        yield line


def explain(e):
    name = type(e).__name__
    msg = str(e) or name
    hints = {
        "NoDeviceConnectedError": "找不到 iPhone：請用 USB 線連接並解鎖",
        "DeviceNotFoundError": "找不到 iPhone：請用 USB 線連接並解鎖",
        "DeveloperModeIsNotEnabledError": "iPhone 未開啟「開發者模式」（設定 → 私隱與安全性 → 開發者模式）",
        "DeveloperModeError": "iPhone 未開啟「開發者模式」（設定 → 私隱與安全性 → 開發者模式）",
        "PairingDialogResponsePendingError": "請在 iPhone 上按「信任此電腦」並輸入密碼",
        "UserDeniedPairingError": "iPhone 上拒絕了信任，請拔線重插再按「信任」",
        "PasswordRequiredError": "請先解鎖 iPhone",
        "UserspaceTunnelUnavailableError": "此 iOS 版本不支援免 root 通道（需要 iOS 17.4+）",
        "ConnectionFailedToUsbmuxdError": "連唔到 usbmuxd（Mac 內置的 iPhone 連線服務）：請重插 USB 線",
    }
    return name, hints.get(name, msg)


async def run(udid):
    from pymobiledevice3.exceptions import AlreadyMountedError
    from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
    from pymobiledevice3.services.mobile_image_mounter import auto_mount

    status("connecting", message="建立 USB 通道（免 root）…")
    async with UserspaceRsdTunnel(serial=udid or None) as rsd:
        emit({
            "t": "hello",
            "udid": getattr(rsd, "udid", ""),
            "model": getattr(rsd, "product_type", ""),
            "ios": getattr(rsd, "product_version", ""),
        })
        status("mounting", message="掛載開發者映像（第一次需下載，請稍候）…")
        try:
            await auto_mount(rsd)
        except AlreadyMountedError:
            pass

        async with DvtProvider(rsd) as dvt, LocationSimulation(dvt) as loc:
            status("ready", message="位置模擬已就緒")
            latest = {"fix": None}
            wake = asyncio.Event()
            done = asyncio.Event()

            async def reader():
                async for raw in stdin_lines():
                    try:
                        m = json.loads(raw)
                    except ValueError:
                        continue
                    if m.get("t") in ("fix", "clear"):
                        latest["fix"] = m  # latest wins: stale fixes are dropped
                        wake.set()
                done.set()
                wake.set()

            reader_task = asyncio.create_task(reader())
            fixes = 0
            last_ack = 0.0
            try:
                while True:
                    await wake.wait()
                    wake.clear()
                    m, latest["fix"] = latest["fix"], None
                    if m is not None:
                        if m["t"] == "clear":
                            await loc.clear()
                            status("cleared", message="已還原真實 GPS")
                        else:
                            lat, lng = float(m["lat"]), float(m["lng"])
                            if -90 <= lat <= 90 and -180 <= lng <= 180:
                                await loc.set(lat, lng)
                                fixes += 1
                                now = time.monotonic()
                                if now - last_ack > 1.0:
                                    emit({"t": "ack", "fixes": fixes})
                                    last_ack = now
                    if done.is_set() and latest["fix"] is None:
                        break
            finally:
                reader_task.cancel()
                try:
                    await loc.clear()
                except Exception:
                    pass


def main():
    udid = os.environ.get("IOS_UDID", "").strip()
    try:
        asyncio.run(run(udid))
    except KeyboardInterrupt:
        pass
    except ImportError as e:
        status("error", error="ImportError", message=f"未安裝 pymobiledevice3：{e}")
        sys.exit(2)
    except Exception as e:  # report and let the Node side retry
        name, msg = explain(e)
        status("error", error=name, message=msg)
        sys.exit(1)


if __name__ == "__main__":
    main()
