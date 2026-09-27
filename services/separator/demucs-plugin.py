#!/usr/bin/env python3
"""
AI 人声分离插件（Demucs）
==========================
实现 `apps/shell/src/separator.js` 约定的插件接口：

    <plugin> --input <wav> --output <wav>

读入一首（或从 MV 里抽出的）wav，写出**伴奏**（去掉人声）的 wav。

为什么单独做成插件而不是内置：
  - Demucs 依赖 PyTorch，光 CPU 版就 200MB+，不该塞进安装包
  - 模型权重也要单独下（首次运行自动下，约 80MB）
  - 不想用的人完全不受影响（内置的"即时分离"零依赖可用）

用法（一般由 setup-demucs.ps1 生成的 separate.cmd 调用，不用手敲）：

    python demucs-plugin.py --input song.wav --output song.accomp.wav
    python demucs-plugin.py --input song.wav --output out.wav --model htdemucs --device cpu

退出码：0 成功；非 0 失败（stderr 会带上可读原因，宿主会显示给用户）。
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile


def log(msg):
    """宿主只收集 stderr，所以进度也走 stderr。"""
    print(msg, file=sys.stderr, flush=True)


def check_demucs():
    """确认 demucs 装在这个解释器里，没装就给一句人话。"""
    try:
        import demucs  # noqa: F401
    except Exception as e:  # pragma: no cover - 环境相关
        log("找不到 demucs：%s" % e)
        log("请先运行 services/separator/setup-demucs.ps1 安装。")
        return False
    return True


def find_stem(out_dir, model, track_name, want):
    """
    在 demucs 的输出目录里找目标音轨。
    demucs 的目录结构是 <out>/<model>/<track>/<stem>.wav
    """
    base = os.path.join(out_dir, model, track_name)
    candidates = [
        os.path.join(base, want + ".wav"),
        os.path.join(base, want + ".mp3"),
        os.path.join(base, want + ".flac"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    # 兜底：递归找同名文件
    for root, _dirs, files in os.walk(out_dir):
        for f in files:
            if os.path.splitext(f)[0] == want:
                return os.path.join(root, f)
    return None


def main():
    ap = argparse.ArgumentParser(description="Demucs 人声分离插件（输出伴奏）")
    ap.add_argument("--input", required=True, help="输入 wav")
    ap.add_argument("--output", required=True, help="输出伴奏 wav")
    ap.add_argument("--model", default="htdemucs", help="demucs 模型名，默认 htdemucs")
    ap.add_argument("--device", default="auto", help="auto / cpu / cuda")
    # demucs 的 --jobs 在 CPU 上开太大反而慢
    ap.add_argument("--jobs", default="1")
    # 给 PyTorch 留几个核心。见下面 OMP_NUM_THREADS 的说明。
    ap.add_argument("--threads", type=int, default=None,
                    help="PyTorch 用的线程数，默认 = 逻辑核心数 - 2")
    args = ap.parse_args()

    # auto：装了 CUDA 版 torch 且显卡可用就走 GPU。
    # 实测同一首歌：CPU 约 2 分钟，RTX 3060 Ti 上约 10 秒 —— 差一个数量级，
    # 直接决定"切到伴唱时伴奏做好了没有"。
    if args.device == "auto":
        try:
            import torch
            args.device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            args.device = "cpu"

    # ⚠️ 分离是**后台**任务，不能把 CPU 全吃掉。
    # 实测 demucs（PyTorch）默认会开满所有逻辑核心，正在播的 MV 会被饿到掉帧 ——
    # 用户看到的是"一开自动分离画面就开始卡"。宿主那边已经把进程降到 BelowNormal，
    # 这里再把**线程数**压下来，给播放器留两个核心的余量。
    if args.threads is None:
        args.threads = max(1, (os.cpu_count() or 4) - 2)
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)

    src = os.path.abspath(args.input)
    dst = os.path.abspath(args.output)

    if not os.path.isfile(src):
        log("输入文件不存在: %s" % src)
        return 2
    if os.path.getsize(src) < 1024:
        log("输入文件太小，不像是有效音频: %s" % src)
        return 2
    if not check_demucs():
        return 3

    out_dir = tempfile.mkdtemp(prefix="ktv-demucs-")
    try:
        track_name = os.path.splitext(os.path.basename(src))[0]
        cmd = [
            sys.executable, "-m", "demucs",
            "--two-stems=vocals",        # 只要人声/伴奏两轨，比四轨快得多
            "-n", args.model,
            "-d", args.device,
            "-j", str(args.jobs),
            "-o", out_dir,
            src,
        ]
        log("开始分离（模型 %s，设备 %s，线程 %d）…首次运行会先下载模型"
            % (args.model, args.device, args.threads))
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if proc.returncode != 0:
            tail = "\n".join((proc.stdout or "").strip().splitlines()[-8:])
            log("demucs 执行失败（退出码 %d）" % proc.returncode)
            if tail:
                log(tail)
            return 4

        # 只要伴奏：demucs 的 two-stems 产物是 vocals.wav / no_vocals.wav
        stem = find_stem(out_dir, args.model, track_name, "no_vocals")
        if not stem:
            log("没找到伴奏产物（no_vocals）。demucs 输出目录: %s" % out_dir)
            return 5

        os.makedirs(os.path.dirname(dst), exist_ok=True)
        # 先写临时文件再改名，避免宿主读到半成品
        tmp = dst + ".part"
        shutil.copyfile(stem, tmp)
        os.replace(tmp, dst)
        log("分离完成: %s" % dst)
        return 0
    except Exception as e:
        log("分离失败: %s" % e)
        return 1
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
