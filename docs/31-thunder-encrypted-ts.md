# 31 · 马赛克与卡顿的真正根因：片源是**迅雷加密 TS**

> 这一篇推翻了 `docs/16` 的结论。之前认为"maidong 的 .ts 每隔 524KB 有一段数据被损坏"，
> **是错的** —— 那不是损坏，是**加密**。

## 一、结论先讲

maidong 分发的 `.ts` **不是明文 TS**，而是**迅雷系加密文件**：

```
[512 字节文件头：加密参数 + 签名]
[正文：按 segment 选择性 AES-256-ECB 加密]
```

官方安卓 APP 下载完会先调 `TsDecryptor` 解密再播（`SongOkDownloadManager.kt:227`）。
我们原来**把密文直接喂给了播放器** —— 于是：

- 被加密的那些 segment 解码成垃圾 → **周期性马赛克**；
- 解复用器遇到密文要反复"重同步" → **卡顿**。

解密之后：**零解码错误、画面干净**（实测）。

## 二、怎么一步步查出来的

### 1. 先确认"不是我们下载写坏的"

从取流接口重新拿地址、用三种方式下载同一个文件，比对 md5：

| 下载方式 | 大小 | md5 |
|---|---|---|
| 单次 GET | 45,410,596 | `438efc7e…` |
| 分块 Range（1MB × 44） | 45,410,596 | `438efc7e…` |
| 设置 `Accept-Encoding: identity` 再下一次 | 45,410,596 | `438efc7e…` |

三者**逐字节相同**，服务器是腾讯 COS（带 `x-amz-hash-crc64ecma`）。
所以文件在 CDN 上就是这样，不是我们写坏的。

### 2. 精确量出"坏块"的结构

按 TS 同步字节（每 188 字节应为 `0x47`）扫全片：

```
坏块数量: 97
坏块长度: 8084 字节（= 43 个 TS 包）为主
坏块间隔: 524144 字节（= 2788 个 TS 包），非常规律
坏块内容: 纯随机字节 —— 8084 字节里只有 28 个 0x47（≈ 随机期望值），
          块内找不到任何 TS 对齐，熵 7.97/8.0
```

**"每 512KB 精确地坏 8KB"这种规律，不像传输损坏，像格式。** 这是第一个转折点。

### 3. 翻安卓源码

在麦动源码目录里搜到 **`TsDecryptor.kt`**：

```kotlin
private const val HEADER_SIZE = 512
private val signatures = listOf("THUNDERCRYP3", "HHCMUSECRYP1", "HHCMUSECRYP2")

fun isEncrypted(file: File?): Boolean {
    if (input.readUnsignedByte() != 0x47) return true        // 首字节不是同步字节 -> 加密
    input.seek(500); signatures.any(signature::contentEquals)
}

fun decryptFile(...) {
    val key = resolveKey(header)                             // 表里选一把
    val segmentSize = header.u8(452) * 1024
    val mode = header.u8(453)
    val interval = header.u8(454)
    val firstEncryptedSegment = header.u8(457)
    // AES/ECB/NoPadding，只解密"该加密"的 segment
    if (shouldDecrypt(segmentIndex, firstEncryptedSegment, interval)) { ... }
    // 产物 = 输入 - 512（丢掉文件头）
}
```

### 4. 对上了

读我们那个文件的头 512 字节：

```
签名(500..511) : "THUNDERCRYP3"
segmentSize    : header[452]*1024 = 8*1024 = 8192   ← 正好是"坏块"的长度
interval       : header[454] = 64                    ← 64*8192 = 524288 ≈ 实测周期 524144
firstEncSeg    : header[457] = 3
keyIndex       : header[53] & 0x0f = 9
```

**全部对上。** 按同样算法解密（AES-256-ECB）：

```
解密段数: 87
输出大小: 45410084（= 45410596 - 512）
前 32768 个包同步字节全对
```

### 5. 画面验证

同一时刻（12.5s）取帧对比：

| | 解码错误（前 60s） | 画面 |
|---|---|---|
| 原始（密文） | 62 条 | 大片马赛克 |
| **解密后** | **0 条** | **干净** |

（`docs/16` 里说的"87 处损坏包" —— 87 正是**被加密的 segment 个数**。）

## 三、实现

### `apps/shell/src/tsdecrypt.js`

`TsDecryptor.kt` 的 Node 移植：

- `isEncrypted(filePath)` —— 首字节不是 `0x47`，或 500..511 是已知签名
- `decryptFile(input, output)` —— 逐 segment 顺序读写（不整文件读进内存），
  AES-256-ECB 解"该解"的 segment，丢掉 512 字节头，产物做 TS 校验
- `decryptInPlace(filePath)` —— 解密到临时文件 → 校验 → 原子替换；失败**原样保留**
- `markPlain / isPlainMarked` —— "已确认明文"标记

### 接进下载管线

```
下载完成 → 改名成正式文件 → 【解密】→ 【修复】→ 标记 done
```

顺序不能反：先修复（重封装）只会把密文原样搬进一个合法容器里，
播放器拿到的还是密文。两个都放在标记 `done` **之前** ——
`done` 的含义必须是"已经可以直接顺畅播放"。

### 老缓存怎么办

**光看文件头分不出**这两种情况：

1. 正常明文 TS；
2. 早期版本把**加密 TS 直接重封装**出来的文件 ——
   容器合法（每 188 字节都是 `0x47`，我们的同步字节扫描查不出问题），
   但内容是密文。实测这种文件解码错误 62 条、画面照样花。

所以在下载管线里解密/确认后打一个 `decrypt-marks/<name>.plain` 标记；
播放时遇到**没有标记的 .ts** 就当成可疑 → 自动强制重下一次（现在会解密）。

实测：播《阴天》时日志出现
`[downloads] 片源已解密: 7005500.ts`，文件从 43.3MB（旧的重封装产物）
变成 45,410,084 字节（= 远端 45,410,596 − 512），前 60 秒解码错误 **0**。

### 加密片源不能流式播

`resolveAndPlay` 里，maidong 的 `.ts` **强制**先下载 + 解密再播，
不管设置里的"先缓存再播"是开是关 —— 直接流式播等于把密文喂给播放器。

## 四、顺带纠正的旧结论

`docs/16-mv-stutter-root-cause.md` 里写的是"片源带周期性损坏包，不可恢复"，
并据此把"片源修复"默认设成了 `off`。现在看：

- 那些"坏包"是**加密段**，可恢复；
- 真正要做的是**解密**，而不是重封装/重编码；
- `docs/16` 里"mpv 直接就能满帧播完"的观测仍然成立（mpv 抗住了重同步），
  但"马赛克是坏段里真的没数据"这条**不成立** —— 解密后马赛克完全消失。

## 五、授权提醒

密钥表取自 maidong 项目（`TsDecryptor.kt`，公开仓库）。本项目是个人自用改造；
**若要分发，请自行确认这部分的授权**（maidong 项目本身标注禁止商用）。

## 相关文件

- `apps/shell/src/tsdecrypt.js` —— 解密实现
- `apps/shell/src/downloads.js` —— 下载 → 解密 → 修复 的顺序
- `apps/shell/src/main.js` —— `ensureDecrypted()` / 老缓存重下
- `apps/shell/test/tsdecrypt-test.js` —— 11 项：现场加密一个真 TS 再解回来，断言逐字节相同