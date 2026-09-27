/**
 * 播放监管器
 * ==========
 * 在线取流地址只有约 1 小时有效期，过期或节点抖动时会断流。
 * 本模块负责：发现异常 -> 重新实时取地址 -> 从断点续播 -> 超限则告知用户。
 *
 * 触发条件有两类（都来自播放器）：
 *   error     libVLC 明确进入 Error 状态
 *   stalled   Playing 但时间轴连续 6 秒不推进（过期时更常见的表现）
 *
 * 只在"在线播放"时介入：本地文件出问题重取地址没有意义。
 */
'use strict';

const MAX_RETRIES = 2;
const SEEK_READY_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PlaybackSupervisor {
  /**
   * @param {object} deps
   * @param {import('@ktv/player').KtvPlayer} deps.player
   * @param {(song:object)=>Promise<{url:string, provider:string, expiresAt:number|null}>} deps.resolveUrl
   * @param {(notice:{kind:string,text:string})=>void} deps.notify
   */
  constructor({ player, resolveUrl, notify }) {
    this.player = player;
    this.resolveUrl = resolveUrl;
    this.notify = notify || (() => {});

    this.song = null;
    this.retries = 0;
    this.lastPosition = 0;
    this.recovering = false;
  }

  /** 换歌时重置状态。song 需带 accomp 与 playSource。 */
  setSong(song) {
    this.song = song || null;
    this.retries = 0;
    this.lastPosition = 0;
    this.recovering = false;
  }

  /** 每次状态推送都记一下播放位置，断流时用来续播。 */
  onStatus(status) {
    if (status && status.time > 0) this.lastPosition = status.time;
  }

  /** 播放器报告异常时调用。 */
  async onFailure(reason) {
    if (this.recovering) return;
    if (!this.song || this.song.playSource !== 'online') return;
    if (this.retries >= MAX_RETRIES) {
      this.notify({ kind: 'warn', text: `《${this.song.name}》播放中断，已重试 ${MAX_RETRIES} 次仍失败。` });
      return;
    }

    this.retries += 1;
    this.recovering = true;
    const resumeAt = this.lastPosition;
    try {
      const resolved = await this.resolveUrl(this.song);
      this.player.load(resolved.url, { accomp: this.song.accomp, isStream: true });
      this.player.play();

      const resumed = await this._seekWhenReady(resumeAt);
      this.notify({
        kind: 'ok',
        text: `《${this.song.name}》播放中断（${reason}），已重新取流`
          + (resumed ? `并从 ${Math.round(resumeAt / 1000)}s 续播` : ''),
      });
    } catch (err) {
      this.notify({ kind: 'warn', text: `《${this.song.name}》重新取流失败：${err.message}` });
    } finally {
      this.recovering = false;
    }
  }

  /** 等媒体就绪后 seek 回断点位置。 */
  async _seekWhenReady(positionMs) {
    if (!positionMs || positionMs < 1000) return false;
    const deadline = Date.now() + SEEK_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const st = this.player.getStatus();
      if (st.time > 200) {
        this.player.seek(positionMs);
        return true;
      }
      await sleep(200);
    }
    return false;
  }
}

module.exports = { PlaybackSupervisor, MAX_RETRIES };
