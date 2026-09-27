# 20. AI 人声分离插件（Demucs）

> 之前文档里写着"AI 分离只有调用约定，无可用插件"。这篇把它做成能用的东西。

## 先说两个 bug

这条路径**从来没跑通过**，只是没人试过：

### 1. `out is not defined`

`apps/shell/src/separator.js` 的 `separateWithPlugin()` 里：

```js
const dir = path.dirname(accompanimentPath(sourceFile, true));
const stem = path.basename(out, path.extname(out));   // ← out 还没定义
...
try {
  const out = accompanimentPath(sourceFile, hasVideo); // ← 到这里才定义
```

变量用在了定义之前，一调用就抛 `ReferenceError: out is not defined`。
单元测试只覆盖了"即时分离"，所以一直没暴露。

### 2. `separator:run` 返回值被覆盖

`main.js` 的处理器在分离完之后，**返回的是取流服务状态**（一段复制粘贴残留）：

```js
// 修之前
try {
  const cfg = ktvApi.loadConfig();
  return { available: list, configFile: ..., maidong: cfg.maidong };   // ← 界面拿到这个
} catch (e) { return { available: [], error: e.message }; }
```

界面因此既看不到成败、也拿不到产物路径。现在改成 `return r;`。

## 插件接口

宿主（`separator.js`）对插件的约定很简单：

```
<plugin> --input <源 wav> --output <伴奏 wav>
```

- 退出码 0 = 成功，非 0 = 失败
- stderr 会被收集并显示给用户（所以插件要把进度和错误都写 stderr）
- 产物必须落在 `--output` 指定的位置

## 装法

```powershell
pwsh -File services/separator/setup-demucs.ps1
```

脚本做四件事：

1. 用 `uv` 建一个 Python 3.11 的独立 venv（torch 的轮子覆盖最好）
2. 装 demucs
3. 生成 `separate.cmd` —— 这就是要填进设置的东西
4. 自检

装完把 `resources/plugins/demucs/separate.cmd` 的完整路径填到
**设置 → 音频分离 → 插件路径**（设置页有"选择…"按钮），
分离方式选 **AI（插件）**。

首次真正分离时 demucs 会自动下模型（htdemucs 约 80MB）。

> ⚠️ **demucs 的依赖声明不全**：只 `pip install demucs` 会在 `import numpy` 时炸。
> 实测缺 `numpy`、`torchaudio`、`einops`、`openunmix`，安装脚本里显式补上了。

## Windows 上必须能调 .cmd

`setup-demucs.ps1` 生成的是 `separate.cmd`，但 **Node 不允许直接 `spawn` 一个 .cmd**
（会抛 EINVAL）。所以宿主改成经 `cmd.exe` 转一手：

```js
const isBatch = /\.(cmd|bat)$/i.test(plugin);
const cmd = isBatch ? (process.env.ComSpec || 'cmd.exe') : plugin;
const argv = isBatch
  ? ['/d', '/c', plugin, '--input', srcWav, '--output', sepWav]
  : ['--input', srcWav, '--output', sepWav];
spawn(cmd, argv, { shell: false, windowsHide: true });
```

（不用 `shell: true` —— 那会把参数拼成字符串，路径里有空格就出问题。）

## 实测

**CPU 上 htdemucs 大约是 0.5x 实时**：239 秒的歌约 2 分钟，10 秒的片段约 10 秒。

分离质量（取 20 秒真实片段，用频带能量对比）：

| 频带 | 原始原唱 | AI 伴奏 | 变化 |
|---|---|---|---|
| **人声带 300–3.4kHz** | −20.7 dB | −29.7 dB | **−9.0 dB** |
| 低频 60–200Hz | −21.9 dB | −26.8 dB | −4.9 dB |

人声带的下降接近低频的 2 倍 —— 说明去掉的主要是人声，不是整体压音量。

产物形态（带画面的 MV 源）：

```
7005500.accomp.ts
  index=0  h264  video      ← 画面原样保留
  index=1  mp2   audio 2ch  ← 单条 AI 伴奏
```

切"伴唱"时宿主会**换文件播放**（`switchSource`），切回"原唱"换回来，
播放位置自动续接。重启后如果伴奏文件还在，`afterSourceReady()` 会自动认出来。

## GPU 加速（默认自动）

demucs 在 CPU 上大约是 **0.33x 实时**：4 分钟的歌要跑 ~80 秒，
经常是"歌都唱到一半了伴奏才做好"。

装 CUDA 版 PyTorch 之后走显卡，同一段音频实测：

| 设备 | 60 秒音频耗时 | 折算 4 分钟的歌 |
|---|---|---|
| CPU（14 线程） | 23.6 s | ≈ 80 s |
| **RTX 3060 Ti** | **6.7 s** | **≈ 15 s** |

（6.7s 里有约 4s 是模型加载 + CUDA 初始化，长音频摊薄后差距更大。）
两条产物的波形相关系数 **0.9993** —— 就是同一条伴奏，只是快。

**怎么开**（一次性，约 2.5GB 下载）：

```powershell
# 官方源在国内经常连不上，用 Aliyun 的 pytorch-wheels 镜像
uv pip install --python resources/plugins/demucs/.venv/Scripts/python.exe `
  --find-links https://mirrors.aliyun.com/pytorch-wheels/cu124/ `
  "torch==2.6.0+cu124" "torchaudio==2.6.0+cu124"
```

装完插件里的 `--device auto` 会自动检测到 CUDA 并切过去（实测日志：
`开始分离（模型 htdemucs，设备 cuda，线程 14）`）。设置页「分离设备」也能强制 cpu/cuda。

> ⚠️ 没装 CUDA 版 torch 时 `auto` 会自动回落 CPU，不会报错。
> ⚠️ 官方 `download.pytorch.org` 在本机实测 **SSL 握手失败**（被墙），所以脚本里写的是 Aliyun 镜像。
## 什么时候用哪个

| | 即时分离 | AI 分离（Demucs） |
|---|---|---|
| 依赖 | 只要 ffmpeg | Python + PyTorch + 模型（约 1.5GB） |
| 速度 | 秒级 | 约 0.5x 实时 |
| 原理 | 中置声道相减 | 神经网络分轨 |
| 效果 | 只对"人声居中"的录音有效 | 对绝大多数歌都有效 |

**默认还是即时分离**（零依赖、秒级）；追求质量时再装插件。

## ⚠️ 两个踩过的坑（都已修）

### 1. 合并回原片时不能用 `-shortest` 就完事 —— MV 结尾会被切掉

AI 分离器（demucs）产出的伴奏比原片**短几秒**是常态（它按 7.8 秒一个 segment 处理，
尾部那段会被裁掉）。实测本机 7 个 `.accomp.ts` **每一个**都比原片短 4.7~7.5 秒：

```
7005500.accomp.ts  accomp=234.611s  src=239.278s  diff=4.667s
7427873.accomp.ts  accomp=354.508s  src=361.979s  diff=7.471s
...
```

老代码合并时写的是 `-c:v copy -shortest` —— ffmpeg 会以**较短的那条（音频）**为准结束封装，
于是 **MV 的结尾被整段切掉**，容器时长也跟着变成音频时长。

后果不只是"少几秒"：唱到后半段切「伴唱」时，mpv 立刻 EOF，
主进程把 EOF 当成"唱完了"→ **直接切下一首**。用户看到的就是
**"点一下伴唱，歌被切走了"**。

修法是先用 `apad` 把伴奏补成无限长（尾部补静音），再让 `-shortest` 以**画面**为准截断：

```js
args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad', '-shortest');
```

产物长度 = 原片长度（回归测试里 mock 一个"把音频裁到 3 秒"的插件，断言产物仍是 5010ms）。

同时 `separator.js` 会**核验已存在的伴奏时长**：比原片短超过 1.5 秒就当它不存在，
下次分离自动重做（量不出来时保守放行，不把用户已经做好的伴奏废掉）。

### 2. 分离不能把 CPU 全吃掉

宿主已经把插件进程降到 `BelowNormal` 且**全局串行**（两个 demucs 各跑满所有核心，
正在播的视频会被直接饿死）。但 PyTorch 默认还会按**逻辑核心数**开线程，
所以插件里再压一层：`--threads` 默认 = 逻辑核心数 − 2，写进 `OMP_NUM_THREADS` /
`MKL_NUM_THREADS` 给 demucs 子进程。

## 相关文件

- `services/separator/demucs-plugin.py` — 插件本体
- `services/separator/setup-demucs.ps1` — 一键安装
- `apps/shell/src/separator.js` — 插件调用（含 .cmd 处理）
- `apps/shell/test/separator-test.js` — 27 项：频谱验证 / MV 保留画面 / mock 插件路径 /
  **产物不被截短** / **残次伴奏检测**
