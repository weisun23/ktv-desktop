# 24. 排序、搜索历史、歌手字母索引

> 四项：队列/收藏/歌单排序、搜索历史、歌手 A-Z 索引。

## 1. 排序：为什么用按钮而不是拖拽

**KTV 现场多半是遥控器或小键盘，拖拽在遥控器上根本没法操作。**
按钮还能拿到键盘焦点（`Tab` 走位 + `Enter` 触发），拖拽不行。

### 队列排序

```
▶ 1  正在唱的歌          （不能动）
  2  歌 A    置顶 ↑ ↓ 删
  3  歌 B    置顶 ↑ ↓ 删
```

- **只能挪 `waiting` 的条目** —— 正在播的那条不能被挪走
- 中间可能夹着 playing，所以要**跨过它去找相邻的 waiting**：

```js
let j = idx + d;
while (j >= 0 && j < q.length && q[j].status !== Waiting) j += d;
```

- 边界判断放在**前端**是为了让按钮置灰（用户一眼知道到头了），
  真正的移动由主进程按权威数据做

### 收藏 / 歌单排序

`favorites` 和 `playlists[name]` 都是 id 数组，交换相邻两项即可。

> 收藏是 `unshift` 进去的（最新的在最前），所以"上移"= 往 `idx-1` 挪。

## 2. 搜索历史

遥控器/小键盘输字很麻烦，**常用的几个词能点一下比重新输一遍强得多**。

- 搜索标签下、输入框为空时显示一排可点的词
- 同一个词再搜一次**挪到最前**，不产生重复项
- 上限 20 条，可单条删或清空
- 只在**第 1 页**记历史（翻页不该产生新纪录）

### 踩到的坑：`@click="runSearch"` 会把事件对象当参数

```html
<button @click="runSearch">搜索</button>   <!-- ← 事件对象被当成 pageNo -->
```

`runSearch(pageNo = 1)` 收到的是 `MouseEvent`，于是 `pageNo === 1` 永远不成立，
**搜索历史一条都记不上**。改成 `@click="runSearch(1)"` 才正常。

> 这个坑是"给函数加了默认参数，却忘了模板里直接绑函数名"的典型。
> 凡是带默认参数的处理器，模板里都应该显式传参。

## 3. 歌手 A-Z 索引

13 万歌手靠搜索不现实。曲库里 `singers.name_cap` 存的就是**拼音首字母**：

```
周杰伦 → ZJL      莫文蔚 → MWW      陈奕迅 → CYX
```

### 查询写法决定性能

| 写法 | 耗时 | 是否走索引 |
|---|---|---|
| `upper(substr(name_cap,1,1)) = ?` | 29 ms | ❌ SCAN |
| `name_cap LIKE 'Z%'` | 17 ms | ❌ SCAN |
| **`name_cap >= 'Z' AND name_cap < '['`** | **4.3 ms** | ✅ SEARCH USING INDEX |

前两种在列上套了函数/大小写折叠，SQLite 用不上 `idx_name_cap`。
**范围比较是唯一能走索引的写法**，快 7 倍。

> 前提：库里没有小写 `name_cap`（实测 0 条），所以直接按大写范围切是安全的。

### 分布接口

```
GET /singers/letters
  -> { letters: [{letter:'A',count:4281}, ..., {letter:'#',count:N}] }
```

`#` 桶装的是数字/符号开头的（比如 `#0000FF` 这种）。界面上没有歌手的字母会置灰。

### 界面

歌手标签下是一条可横向滚动的字母条 `A B C ... Z #`，
选中高亮，再点一次取消；点字母会**清掉搜索词**（两者一起用没意义）。

## 相关文件

- `apps/shell/src/state.js` — `moveInQueue` / `moveFavorite` / `moveInPlaylist` / 搜索历史
- `services/catalog/src/db.js` — `_letterCond` / `singerLetters`
- `apps/web/src/components/QueuePanel.vue` — ↑↓ 按钮
- `apps/web/src/components/CatalogBrowser.vue` — 字母条、搜索历史条
- `apps/shell/test/state-test.js` — 57 项（含排序 8 项、搜索历史 8 项）
- `services/catalog/test/db-test.js` — 28 项（含字母索引 5 项）
- `services/catalog/test/server-test.js` — 18 项（含字母接口 3 项）
