# packages/ktv-api

取流 provider：把"曲目"解析成"可播放地址"。播放器不关心地址从哪来。

## 设计原则

**代码里不含任何第三方凭证。** 凭证只从本地配置读取：

```
resources/config/providers.json     （已被 .gitignore 排除）
```

原因：这些凭证属于第三方 KTV 服务，是**授权问题**而非版权问题。
详见 `docs/00-architecture.md` §4 与 `docs/04-phase3-online.md` §3。

## 用法

```js
const ktvApi = require('@ktv/ktv-api');

// 为曲目实时解析播放地址
const { url, provider, expiresAt } = await ktvApi.resolvePlayUrl({
  musicNo: '7789715',        // songs.filename 去扩展名
  filename: '7789715.ts',
});

// 查看可用 provider
const providers = ktvApi.availableProviders(ktvApi.loadConfig());
```

## 已实现

### `maidong`

参考 maidong 的接口流程**自行实现**（未复制其源码）：

| 步骤 | 请求 |
|---|---|
| 取 token | `GET {host}/i.php` — `sign = md5(params + appKey)` |
| 取地址 | `GET {host}/music/do.php` — `sign = md5(params + sdkKey)` |

三个实测要点：

1. **地址约 1 小时过期** → 必须每次播放前实时获取，不能缓存。
2. **部分节点只返回 demo 地址** → 需按 `host × ls` 组合尝试并校验结果。
3. **服务端在 JSON 前打印 PHP 警告** → 解析必须容错。

配置字段：

```json
{
  "maidong": {
    "enabled": true,
    "hosts": ["http://主节点", "http://备用节点"],
    "appId": "", "appKey": "", "sdkKey": "",
    "ver": "2.0", "vn": "", "resolution": "720", "deviceIp": ""
  }
}
```

## 规划中

- `online` —— 接 karaoke-companion 的在线音乐聚合（网易/QQ/酷狗/B站等，MIT 授权），
  作为补充与备份源，减少对单一第三方服务的依赖。
- provider 热更新 —— 接口参数远程可更，降低服务变更的维护成本。

## 测试

```powershell
npm test              # 20 项，本地 mock，不联网
npm run test:live     # 真实联网端到端（需先配置凭证）
```
