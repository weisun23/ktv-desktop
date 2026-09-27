#!/usr/bin/env python3
"""
libVLC 窗口嵌入验证 —— 证明能把视频渲染进一个外部 HWND。

这是 Tauri 方案的关键机制：Web 层留出视频区 -> 取到该区域的 HWND ->
交给 libVLC 渲染 -> HTML/CSS 控件叠在上层。Windows 上 libVLC 用的是
Direct3D 视频输出，必须真的绑定到一个 HWND 才能出画。

本脚本用 ctypes 直接创建一个 Win32 窗口（复用系统内置 "Static" 类，无需注册
窗口过程），把它的 HWND 交给 libVLC，然后检查是否真的建立了视频输出。

用法: python vlc_embed_verify.py [--visible]
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VLC_DIR = REPO_ROOT / "resources" / "runtime" / "vlc" / "vlc-3.0.21"
TESTMEDIA = REPO_ROOT / "testmedia"


def _bootstrap_libvlc() -> Path:
    dll = VLC_DIR / "libvlc.dll"
    if not dll.exists():
        sys.exit(f"找不到 libvlc.dll: {dll}")
    os.add_dll_directory(str(VLC_DIR))
    os.environ.setdefault("PYTHON_VLC_LIB_PATH", str(dll))
    os.environ.setdefault("PYTHON_VLC_MODULE_PATH", str(VLC_DIR / "plugins"))
    return dll


_bootstrap_libvlc()
import vlc  # noqa: E402

WS_OVERLAPPEDWINDOW = 0x00CF0000
WS_POPUP = 0x80000000
SW_SHOW, SW_HIDE = 5, 0


def create_host_window(title: str, w: int, h: int, visible: bool) -> int:
    """创建一个 Win32 宿主窗口并返回 HWND。用系统 'Static' 类免注册。"""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
    ]
    style = WS_OVERLAPPEDWINDOW if visible else WS_POPUP
    hwnd = user32.CreateWindowExW(
        0, "Static", title, style, 80, 80, w, h, None, None, None, None
    )
    if not hwnd:
        raise ctypes.WinError(ctypes.get_last_error())
    return hwnd


def pump_messages() -> None:
    """跑一轮消息循环，让窗口保持响应。"""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    msg = wintypes.MSG()
    while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--media", type=Path, default=TESTMEDIA / "ktv_lr.ts")
    ap.add_argument("--visible", action="store_true", help="显示宿主窗口（默认隐藏）")
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()

    if sys.platform != "win32":
        sys.exit("本脚本仅适用于 Windows")

    media = args.media
    if not media.exists():
        sys.exit(f"片源不存在: {media}")

    checks = []

    def record(name, ok, detail=""):
        checks.append({"name": name, "passed": bool(ok), "detail": detail})
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))
        return ok

    print(f"片源: {media.name}")
    print(f"宿主窗口: {'可见' if args.visible else '隐藏'}\n")

    hwnd = create_host_window("KTV PoC host window", 1280, 720, args.visible)
    record("创建宿主 HWND", bool(hwnd), f"hwnd=0x{hwnd:X}")

    instance = vlc.Instance(["--quiet", "--no-video-title-show", "--no-osd"])
    if instance is None:
        sys.exit("vlc.Instance() 返回 None")
    player = instance.media_player_new()
    player.set_media(instance.media_new(str(media)))
    player.set_hwnd(hwnd)

    if args.visible:
        ctypes.WinDLL("user32").ShowWindow(hwnd, SW_SHOW)

    player.play()

    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        pump_messages()
        if player.has_vout() and player.get_time() > 200:
            break
        time.sleep(0.1)

    has_vout = bool(player.has_vout())
    record("在外部 HWND 上建立视频输出 (has_vout)", has_vout,
           f"state={player.get_state()} time={player.get_time()}ms")

    w, h = player.video_get_size(0) if has_vout else (0, 0)
    record("视频尺寸已就绪", w > 0 and h > 0, f"{w}x{h}")

    playing = player.get_state() == vlc.State.Playing and player.get_time() > 0
    record("嵌入后正常播放并推进时间轴", playing, f"time={player.get_time()}ms")

    # 播放中切声道，确认嵌入状态下原伴唱切换依然可用
    rc = player.audio_set_channel(3)  # left
    time.sleep(0.6)
    got = player.audio_get_channel()
    record("嵌入状态下仍可切声道", rc == 0 and got == 3, f"channel={got}")

    player.stop()
    player.release()
    instance.release()
    ctypes.WinDLL("user32").DestroyWindow(hwnd)

    failed = [c for c in checks if not c["passed"]]
    print()
    print("结论: 嵌入验证" + ("通过" if not failed else f"存在 {len(failed)} 项失败"))
    print("说明: 隐藏窗口下 D3D vout 仍能建立，说明 set_hwnd 路径可用；"
          "实际画面呈现请用 --visible 或 vlc_poc.py --interactive 目视确认。")

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(
            {"media": str(media), "passed": not failed, "checks": checks},
            ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"报告: {args.report}")

    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
