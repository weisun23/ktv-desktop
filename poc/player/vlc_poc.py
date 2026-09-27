#!/usr/bin/env python3
"""
libVLC KTV 播放能力 PoC
=======================
验证 Windows 端 KTV 播放器的四项硬性能力，这四项决定 Tauri 架构是否可行：

  1. 播放 KTV MPEG-TS（H.264 + MP2）并能 seek
  2. 枚举单文件内的多条音轨
  3. 切换音轨（对应 Android 端 IjkMediaPlayer.selectAudioTrack）
  4. 切换声道 stereo/left/right（对应 IjkMediaPlayer.seletcAudioChannel）

第 3 项对应"新式 KTV 片源"（原唱/伴唱各一条音轨），
第 4 项对应"老式 KTV 片源"（左声道伴唱、右声道原唱）。

用法:
  python vlc_poc.py --selftest              # 无窗口自检，输出 JSON 报告
  python vlc_poc.py --interactive           # 嵌入窗口，键盘切换原伴唱
  python vlc_poc.py --selftest --media X.ts # 用真实片源跑自检
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
VLC_DIR = REPO_ROOT / "resources" / "runtime" / "vlc" / "vlc-3.0.21"
TESTMEDIA = REPO_ROOT / "testmedia"

# libvlc_AudioChannel_* —— python-vlc 未导出该枚举，按 C 头文件取值
CH_ERROR, CH_STEREO, CH_RSTEREO, CH_LEFT, CH_RIGHT, CH_DOLBYS = -1, 1, 2, 3, 4, 5
CHANNEL_NAMES = {
    CH_STEREO: "stereo", CH_RSTEREO: "reverse-stereo",
    CH_LEFT: "left", CH_RIGHT: "right", CH_DOLBYS: "dolby",
}


def _bootstrap_libvlc() -> Path:
    """让 python-vlc 找到便携版 libvlc，并把同目录加入 DLL 搜索路径。"""
    dll = VLC_DIR / "libvlc.dll"
    if not dll.exists():
        sys.exit(f"找不到 libvlc.dll: {dll}\n请先执行 poc/player/fetch-vlc.ps1")
    os.add_dll_directory(str(VLC_DIR))
    os.environ.setdefault("PYTHON_VLC_LIB_PATH", str(dll))
    os.environ.setdefault("PYTHON_VLC_MODULE_PATH", str(VLC_DIR / "plugins"))
    return dll


LIBVLC_DLL = _bootstrap_libvlc()
import vlc  # noqa: E402


@dataclass
class Check:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class Report:
    media: str = ""
    libvlc_version: str = ""
    expect_tracks: int | None = None
    audio_tracks: list = field(default_factory=list)
    track_switch_log: list = field(default_factory=list)
    channel_switch_log: list = field(default_factory=list)
    checks: list = field(default_factory=list)

    def add(self, name: str, passed: bool, detail: str = "") -> bool:
        self.checks.append(Check(name, bool(passed), detail))
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))
        return bool(passed)

    @property
    def ok(self) -> bool:
        return all(c.passed for c in self.checks)


def wait_until(pred, timeout: float, interval: float = 0.1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def build_instance(extra=None):
    args = ["--quiet", "--no-video-title-show", "--no-snapshot-preview",
            "--no-osd", "--no-stats", "--file-caching=1000", "--network-caching=1500"]
    args += extra or []
    return vlc.Instance(args)


def track_label(entry) -> str:
    tid, name = entry
    if isinstance(name, bytes):
        name = name.decode("utf-8", "replace")
    return str(name or "")


# ────────────────────────────── 自检 ──────────────────────────────

def run_selftest(media: Path, keep_audio: bool, expect_tracks: int | None = None) -> Report:
    rep = Report(media=str(media), expect_tracks=expect_tracks)
    if not media.exists():
        rep.add("测试片源存在", False, str(media))
        return rep
    rep.add("测试片源存在", True, f"{media.name} ({media.stat().st_size/1e6:.1f} MB)")

    # 无窗口：dummy vout/aout，避免自检时弹窗和出声
    extra = ["--vout=dummy"] + ([] if keep_audio else ["--aout=adummy"])
    instance = build_instance(extra)
    _ver = vlc.libvlc_get_version()
    rep.libvlc_version = _ver.decode("utf-8", "replace") if isinstance(_ver, bytes) else str(_ver)
    rep.add("libVLC 版本", True, rep.libvlc_version)

    player = instance.media_player_new()
    player.set_media(instance.media_new(str(media)))

    # --- 1. 能起播并推进进度 ---
    player.play()
    started = wait_until(
        lambda: player.get_state() in (vlc.State.Playing, vlc.State.Buffering) and player.get_time() > 200,
        timeout=25,
    )
    rep.add("起播 KTV TS 并推进时间轴", started,
            f"state={player.get_state()} time={player.get_time()}ms")

    # --- 2. 枚举音轨 ---
    got_tracks = wait_until(lambda: player.audio_get_track_count() > 0, timeout=10)
    descs = player.audio_get_track_description() or []
    rep.audio_tracks = [{"id": tid, "name": track_label((tid, name))} for tid, name in descs]
    rep.add("枚举音轨", got_tracks and len(descs) > 0,
            f"count={player.audio_get_track_count()} tracks={rep.audio_tracks}")

    # --- 3. 切换音轨 ---
    switchable = [t["id"] for t in rep.audio_tracks if t["id"] >= 0]
    track_ok = len(switchable) >= 1
    for tid in switchable:
        rc = player.audio_set_track(tid)
        time.sleep(0.5)
        cur = player.audio_get_track()
        rep.track_switch_log.append({"set": tid, "rc": rc, "readback": cur, "match": cur == tid})
        print(f"    audio_set_track({tid}) rc={rc} -> audio_get_track()={cur}")
        track_ok = track_ok and (cur == tid)
    if expect_tracks is not None:
        track_ok = track_ok and len(switchable) == expect_tracks
    rep.add("切换音轨并回读一致", track_ok,
            f"switchable={switchable} expect={expect_tracks if expect_tracks is not None else '>=1'}")

    # --- 4. 切换声道 ---
    channel_ok = True
    for mode in (CH_LEFT, CH_RIGHT, CH_STEREO):
        rc = player.audio_set_channel(mode)
        time.sleep(0.4)
        cur = player.audio_get_channel()
        rep.channel_switch_log.append({"set": CHANNEL_NAMES.get(mode, mode), "rc": rc,
                                       "readback": cur, "readback_name": CHANNEL_NAMES.get(cur, cur),
                                       "match": cur == mode})
        print(f"    audio_set_channel({CHANNEL_NAMES.get(mode)}) rc={rc} -> get={CHANNEL_NAMES.get(cur, cur)}")
        channel_ok = channel_ok and (rc == 0) and (cur == mode)
    rep.add("切换声道 L/R/Stereo 并回读一致", channel_ok)

    # --- 5. seek ---
    player.audio_set_channel(CH_STEREO)
    player.set_time(15000)
    seeked = wait_until(lambda: abs(player.get_time() - 15000) < 4000, timeout=12)
    rep.add("seek 到 15s", seeked, f"position={player.get_time()}ms")

    player.stop()
    player.release()
    instance.release()
    return rep


# ─────────────────────────── 交互模式（嵌入窗口） ───────────────────────────

def run_interactive(media: Path):
    """把 libVLC 渲染到一个 Tk 窗口的 HWND 上 —— 验证 Tauri 里同样的嵌入方式。"""
    import tkinter as tk

    instance = build_instance()
    player = instance.media_player_new()
    player.set_media(instance.media_new(str(media)))

    root = tk.Tk()
    root.title("libVLC KTV PoC | [1]伴唱音轨 [2]原唱音轨 [L]左 [R]右 [S]立体声 [空格]暂停 [Q]退出")
    root.geometry("1280x760")
    video = tk.Frame(root, bg="black")
    video.pack(fill="both", expand=True)
    status = tk.Label(root, anchor="w", bg="#101820", fg="#8ef", font=("Consolas", 11), height=2)
    status.pack(fill="x")
    root.update_idletasks()

    player.set_hwnd(video.winfo_id())
    player.play()

    tracks = []

    def refresh_tracks():
        nonlocal tracks
        tracks = [t for t in (player.audio_get_track_description() or []) if t[0] >= 0]
        return tracks

    def say(msg):
        status.config(text=f"{msg}   |   state={player.get_state()} "
                           f"pos={player.get_time()/1000:.1f}s  tracks={len(tracks)}  "
                           f"ch={CHANNEL_NAMES.get(player.audio_get_channel(), '?')}")

    def set_track(idx):
        ts = refresh_tracks() or tracks
        if idx < len(ts):
            player.audio_set_track(ts[idx][0])
            say(f"音轨[{idx}] id={ts[idx][0]} name={track_label(ts[idx])}")
        else:
            say(f"该片源只有 {len(ts)} 条音轨")

    def set_channel(mode):
        player.audio_set_channel(mode)
        say(f"声道={CHANNEL_NAMES.get(mode)}")

    def on_key(e):
        k = e.keysym.lower()
        if k == "1": set_track(0)
        elif k == "2": set_track(1)
        elif k == "l": set_channel(CH_LEFT)
        elif k == "r": set_channel(CH_RIGHT)
        elif k == "s": set_channel(CH_STEREO)
        elif k == "space":
            player.pause() if player.is_playing() else player.play()
            say("暂停/继续")
        elif k == "q":
            root.destroy()
        elif k == "left":
            player.set_time(max(0, player.get_time() - 5000)); say("后退 5s")
        elif k == "right":
            player.set_time(player.get_time() + 5000); say("前进 5s")

    root.bind("<Key>", on_key)
    root.after(1200, lambda: (refresh_tracks(), say("就绪")))
    try:
        root.mainloop()
    finally:
        player.stop()
        player.release()
        instance.release()


# ────────────────────────────────── CLI ──────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="libVLC KTV 播放能力 PoC")
    ap.add_argument("--selftest", action="store_true", help="无窗口自检并输出 JSON 报告")
    ap.add_argument("--interactive", action="store_true", help="嵌入窗口交互播放")
    ap.add_argument("--media", type=Path, default=None, help="片源路径（默认跑两份合成测试片）")
    ap.add_argument("--keep-audio", action="store_true", help="自检时保留真实音频输出（默认 adummy 静音）")
    ap.add_argument("--report", type=Path, default=None, help="JSON 报告输出路径")
    args = ap.parse_args()

    if not args.selftest and not args.interactive:
        ap.print_help()
        return 1

    if args.interactive:
        run_interactive(args.media or (TESTMEDIA / "ktv_2tracks.ts"))
        return 0

    if args.media:
        medias = [(args.media, None)]
    else:
        medias = [(TESTMEDIA / "ktv_2tracks.ts", 2), (TESTMEDIA / "ktv_lr.ts", 1)]

    reports = []
    for m, expect in medias:
        print(f"\n=== 自检: {m.name} (期望音轨数={expect if expect is not None else '不限'}) ===")
        reports.append(run_selftest(m, args.keep_audio, expect_tracks=expect))

    overall = all(r.ok for r in reports)
    print(f"\n总结果: {'全部通过' if overall else '存在失败项'}")

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        payload = {"overall": overall, "reports": [asdict(r) for r in reports]}
        args.report.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"报告已写入 {args.report}")

    return 0 if overall else 2


if __name__ == "__main__":
    sys.exit(main())
