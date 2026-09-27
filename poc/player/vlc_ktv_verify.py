#!/usr/bin/env python3
"""
libVLC KTV 原伴唱切换 —— 端到端验证（音频级）
=============================================
证明"切原伴唱"真的改变了输出音频，而不只是 API 返回 0。

方法：用 libVLC 的 amem（内存音频输出）回调，在进程内直接拿到**经过切换之后**
的 PCM，再用 Goertzel 算法测量两个测试频点的能量占比：

    440Hz = 测试片里的"伴唱"    880Hz = 测试片里的"原唱"

覆盖 KTV 片源的两种原伴唱载体，各只播放一次、在播放中途实时切换：

  A. 声道型（老式 KTV TS）  左声道=伴唱，右声道=原唱
     ktv_lr.ts     切换 stereo / left / right
  B. 音轨型（新式 KTV TS）  两条独立音轨
     ktv_2tracks.ts 切换 Track0(伴唱) / Track1(原唱)

用法:
  python vlc_ktv_verify.py                 # 跑全部场景
  python vlc_ktv_verify.py --report r.json
"""
from __future__ import annotations

import argparse
import array
import ctypes
import json
import math
import os
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
VLC_DIR = REPO_ROOT / "resources" / "runtime" / "vlc" / "vlc-3.0.21"
TESTMEDIA = REPO_ROOT / "testmedia"

CH_STEREO, CH_LEFT, CH_RIGHT = 1, 3, 4
ACCOMPANIMENT_HZ = 440.0
ORIGINAL_HZ = 880.0
CHANNELS, RATE = 2, 48000
SETTLE_SECONDS = 1.5
MEASURE_SECONDS = 2.0

# libvlc_audio_play_cb: void (*)(void *opaque, const void *samples, unsigned count, int64_t pts)
# python-vlc 只提供同名文档桩（c_void_p 子类），运行时必须自己定义 CFUNCTYPE
AudioPlayCb = ctypes.CFUNCTYPE(
    None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_int64
)


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


# ───────────────────────────── 频谱分析 ─────────────────────────────

def goertzel_power(samples, rate: float, freq: float) -> float:
    n = len(samples)
    if n == 0:
        return 0.0
    k = int(0.5 + n * freq / rate)
    w = 2.0 * math.pi * k / n
    coeff = 2.0 * math.cos(w)
    s1 = s2 = 0.0
    for x in samples:
        s0 = x + coeff * s1 - s2
        s2, s1 = s1, s0
    return max(0.0, (s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n * n)


def analyze(pcm: array.array, start_frame: int, end_frame: int):
    """把 [start,end) 帧的立体声 PCM 混单声道后测两个频点，返回能量占比。"""
    seg = pcm[start_frame * CHANNELS:end_frame * CHANNELS]
    n = len(seg) // CHANNELS
    if n < 1024:
        return 0.0, 0.0, 0.0
    mono = [0.0] * n
    for i in range(n):
        mono[i] = (seg[i * CHANNELS] + seg[i * CHANNELS + 1]) / 65536.0
    m = len(mono)
    win = [mono[i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / (m - 1))) for i in range(m)]
    p_a = goertzel_power(win, RATE, ACCOMPANIMENT_HZ)
    p_o = goertzel_power(win, RATE, ORIGINAL_HZ)
    total = p_a + p_o
    return (0.0, 0.0, n / RATE) if total <= 1e-12 else (p_a / total, p_o / total, n / RATE)


# ─────────────────────────── 采集与场景执行 ───────────────────────────

@dataclass
class Segment:
    label: str
    expect: str
    accomp_ratio: float = 0.0
    original_ratio: float = 0.0
    seconds: float = 0.0
    verdict: str = ""
    passed: bool = False


def open_player(media: Path):
    instance = vlc.Instance(["--quiet", "--no-video-title-show", "--no-osd", "--vout=dummy"])
    if instance is None:
        sys.exit("vlc.Instance() 返回 None")
    player = instance.media_player_new()
    player.set_media(instance.media_new(str(media)))
    player.audio_set_format("S16N", RATE, CHANNELS)
    return instance, player


def capture(media: Path, steps, settle=SETTLE_SECONDS, measure=MEASURE_SECONDS):
    """播放一次，按 steps 顺序执行切换，逐段采集 PCM。

    steps: [(label, expect, resolve)]  resolve(player) -> 切换动作描述
    返回 (pcm, {label: (start_frame, end_frame)})
    """
    instance, player = open_player(media)
    pcm = array.array("h")
    state = {"frames": 0, "errors": 0}

    def on_play(opaque, samples, count, pts):
        # 注意：这里的 samples 就是采样数据首地址（交错 LRLR...），
        # 不是"平面指针数组"——那是视频格式回调的约定。
        try:
            if count and samples:
                buf = array.array("h")
                buf.frombytes(ctypes.string_at(samples, count * CHANNELS * 2))
                pcm.extend(buf)
                state["frames"] += count
        except Exception:
            state["errors"] += 1

    play_cb = AudioPlayCb(on_play)  # 必须持引用，否则被 GC
    player.audio_set_callbacks(play_cb, None, None, None, None, None)
    player.play()

    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if player.get_state() == vlc.State.Playing and state["frames"] > 0:
            break
        time.sleep(0.1)
    if state["frames"] == 0:
        player.stop(); player.release(); instance.release()
        sys.exit(f"amem 回调没有收到音频样本: {media.name}")

    marks = {}
    for label, _expect, resolve in steps:
        resolve(player)
        time.sleep(settle)
        start = state["frames"]
        time.sleep(measure)
        marks[label] = (start, state["frames"])

    player.stop(); player.release(); instance.release()
    return pcm, marks, state["errors"]


def judge(label: str, expect: str, a: float, o: float) -> tuple[bool, str]:
    if expect == "accomp":
        return a > 0.9, (f"伴唱主导 440Hz={a:.4f}" if a > 0.9 else f"未隔离伴唱 440Hz={a:.4f}")
    if expect == "original":
        return o > 0.9, (f"原唱主导 880Hz={o:.4f}" if o > 0.9 else f"未隔离原唱 880Hz={o:.4f}")
    ok = 0.25 < a < 0.75 and 0.25 < o < 0.75
    return ok, (f"双声道混合 440={a:.3f} 880={o:.3f}" if ok else f"混合异常 440={a:.3f} 880={o:.3f}")


def run_scenario(name: str, media: Path, steps, resolve_track: bool = False):
    print(f"\n=== 场景 {name}: {media.name} ===")
    if not media.exists():
        print(f"  [FAIL] 片源不存在: {media}")
        return [Segment(label="片源", expect="", verdict="片源不存在", passed=False)]

    if resolve_track:
        # 音轨型需要先起播拿到真实 track id，再构造步骤
        inst, plr = open_player(media)
        plr.play()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and plr.audio_get_track_count() <= 1:
            time.sleep(0.1)
        ids = [t[0] for t in (plr.audio_get_track_description() or []) if t[0] >= 0]
        plr.stop(); plr.release(); inst.release()
        if len(ids) < 2:
            print(f"  [FAIL] 只发现 {len(ids)} 条音轨，期望 >=2")
            return [Segment(label="音轨枚举", expect="", verdict=f"只发现 {len(ids)} 条音轨", passed=False)]
        print(f"  发现音轨 id: {ids}")
        steps = [(f"Track{idx}", expect, (lambda i: (lambda p: p.audio_set_track(ids[i])))(idx))
                 for idx, (_l, expect, _r) in enumerate(steps)]

    pcm, marks, errors = capture(media, steps)
    if errors:
        print(f"  注意: 回调异常 {errors} 次")

    out: list[Segment] = []
    for label, expect, _resolve in steps:
        start, end = marks[label]
        a, o, secs = analyze(pcm, start, end)
        ok, verdict = judge(label, expect, a, o)
        out.append(Segment(label=label, expect=expect, accomp_ratio=a, original_ratio=o,
                           seconds=secs, verdict=verdict, passed=ok))
        print(f"  [{'PASS' if ok else 'FAIL'}] {label:<18} {verdict}   ({secs:.2f}s)")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path, default=None)
    ap.add_argument("--only", choices=["channel", "track"], default=None)
    args = ap.parse_args()

    print("KTV 原伴唱切换端到端验证 (libVLC + amem 回调 + Goertzel 频谱分析)")
    print(f"约定: 440Hz=伴唱  880Hz=原唱")

    all_results: list[Segment] = []

    if args.only in (None, "channel"):
        all_results += run_scenario(
            "A 声道型 (左=伴唱 右=原唱)", TESTMEDIA / "ktv_lr.ts",
            [("stereo", "both", lambda p: p.audio_set_channel(CH_STEREO)),
             ("left", "accomp", lambda p: p.audio_set_channel(CH_LEFT)),
             ("right", "original", lambda p: p.audio_set_channel(CH_RIGHT))],
        )

    if args.only in (None, "track"):
        all_results += run_scenario(
            "B 音轨型 (Track0=伴唱 Track1=原唱)", TESTMEDIA / "ktv_2tracks.ts",
            [("Track0", "accomp", None), ("Track1", "original", None)],
            resolve_track=True,
        )

    failed = [r for r in all_results if not r.passed]
    print()
    if failed:
        print(f"结论: 存在 {len(failed)} 项失败")
        for r in failed:
            print(f"  - {r.label}: {r.verdict}")
    else:
        print(f"结论: 全部通过（{len(all_results)} 项）—— 两种 KTV 原伴唱载体在 Windows/libVLC 上均可用")

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({
            "passed": not failed,
            "method": "libVLC amem audio callbacks + Goertzel",
            "results": [asdict(r) for r in all_results],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"报告: {args.report}")

    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())
