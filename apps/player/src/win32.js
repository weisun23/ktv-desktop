/**
 * Win32 视频承载窗口
 * ==================
 * libVLC 需要渲染到一个 HWND。如果直接给它 Electron 主窗口的 HWND，视频会盖住
 * 整个窗口（包括 HTML 界面）。所以这里创建一个 WS_CHILD 子窗口，挂在主窗口下、
 * 摆放在界面预留的视频区域里：
 *
 *   - 子窗口会被父窗口裁剪，随父窗口移动/最小化，不需要额外同步
 *   - HTML 界面在子窗口之外照常显示与交互
 *   - 代价：HTML 元素无法叠加在视频之上，所以控件要放在视频区之外
 *
 * 这是阶段 1 的取舍；若将来需要"进度条浮在画面上"，得改成双窗口方案。
 */
'use strict';

const koffi = require('koffi');

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const HWND_TOP = 0;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SW_HIDE = 0;
const SW_SHOW = 5;

let user32 = null;
function u32() {
  if (!user32) user32 = koffi.load('user32.dll');
  return user32;
}

const fns = {};
function fn(key, signature) {
  if (!fns[key]) fns[key] = u32().func(signature);
  return fns[key];
}

const CreateWindowExW = () => fn('create', 'void *CreateWindowExW(uint32 dwExStyle, const char16_t *lpClassName,'
  + ' const char16_t *lpWindowName, uint32 dwStyle, int x, int y, int nWidth, int nHeight,'
  + ' void *hWndParent, void *hMenu, void *hInstance, void *lpParam)');
const DestroyWindow = () => fn('destroy', 'int DestroyWindow(void *hWnd)');
const ShowWindow = () => fn('show', 'int ShowWindow(void *hWnd, int nCmdShow)');
const SetWindowPos = () => fn('setpos', 'int SetWindowPos(void *hWnd, void *hWndInsertAfter,'
  + ' int X, int Y, int cx, int cy, uint32 uFlags)');

// ── 双击检测用（见 main.js 的说明：原生子窗口会吞掉鼠标事件）──
const GetCursorPos = () => fn('getcursorpos', 'int GetCursorPos(void *lpPoint)');
const GetAsyncKeyState = () => fn('getasynckeystate', 'int16 GetAsyncKeyState(int vKey)');
const GetWindowRect = () => fn('getwindowrect', 'int GetWindowRect(void *hWnd, void *lpRect)');
const IsWindowVisible = () => fn('iswindowvisible', 'int IsWindowVisible(void *hWnd)');

/** 当前光标的屏幕物理坐标。 */
function cursorPos() {
  const buf = Buffer.alloc(8);
  GetCursorPos()(buf);
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
}

/** 鼠标左键当前是否按下。 */
function leftButtonDown() {
  return (GetAsyncKeyState()(0x01) & 0x8000) !== 0;
}

/** 窗口在屏幕上的物理矩形。 */
function windowRect(hwnd) {
  const buf = Buffer.alloc(16);
  GetWindowRect()(hwnd, buf);
  const left = buf.readInt32LE(0), top = buf.readInt32LE(4);
  const right = buf.readInt32LE(8), bottom = buf.readInt32LE(12);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

class VideoSurface {
  /**
   * @param {bigint} parentHwnd Electron 主窗口的 HWND
   * @param {{scaleFactor?: number}} [opts] 用于把 DIP 坐标换算成物理像素
   */
  constructor(parentHwnd, opts = {}) {
    if (!parentHwnd) throw new Error('VideoSurface 需要父窗口 HWND');
    this.parentHwnd = parentHwnd;
    this.scaleFactor = opts.scaleFactor || 1;
    this.hwnd = CreateWindowExW()(
      0, 'Static', 'KTV video surface',
      WS_CHILD | WS_VISIBLE,
      0, 0, 16, 16,
      parentHwnd, null, null, null
    );
    if (!this.hwnd) throw new Error('创建视频承载子窗口失败');
    this.bounds = { x: 0, y: 0, width: 16, height: 16 };
  }

  /**
   * 设置视频区位置（DIP 坐标，相对窗口内容区左上角）。
   * @param {{x:number,y:number,width:number,height:number}} rect
   */
  setBounds(rect) {
    const s = this.scaleFactor;
    const x = Math.round(rect.x * s);
    const y = Math.round(rect.y * s);
    const w = Math.max(1, Math.round(rect.width * s));
    const h = Math.max(1, Math.round(rect.height * s));
    this.bounds = { x, y, width: w, height: h };
    // ⚠️ 不能带 SWP_NOZORDER：Chromium 的渲染窗口（Chrome_RenderWidgetHostHWND）
    // 覆盖整个客户区，且会在重绘时把自己提到前面，把视频子窗口压到下面 → 画面空白。
    // 这里显式置顶（HWND_TOP），并用 SWP_NOACTIVATE 避免抢焦点。
    SetWindowPos()(this.hwnd, HWND_TOP, x, y, w, h, SWP_NOACTIVATE);
  }

  show() {
    ShowWindow()(this.hwnd, SW_SHOW);
    // 显示后再置顶一次，确保盖在 Chromium 渲染窗口之上
    const b = this.bounds;
    SetWindowPos()(this.hwnd, HWND_TOP, b.x, b.y, b.width, b.height, SWP_NOACTIVATE);
  }
  hide() { ShowWindow()(this.hwnd, SW_HIDE); }

  isVisible() { return !!this.hwnd && !!IsWindowVisible()(this.hwnd); }

  /** 供 libVLC 使用的句柄 */
  handle() { return this.hwnd; }

  destroy() {
    if (this.hwnd) {
      DestroyWindow()(this.hwnd);
      this.hwnd = null;
    }
  }
}

const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const WS_POPUP = 0x80000000;
const SW_RESTORE = 9;

/**
 * 创建一个顶层宿主窗口（测试与 PoC 用）。
 * 复用系统内置 "Static" 类，无需注册窗口过程。
 * @param {{title?:string, width?:number, height?:number, visible?:boolean}} [opts]
 * @returns {bigint} HWND
 */
function createHostWindow(opts = {}) {
  const { title = 'KTV host', width = 1280, height = 720, visible = false } = opts;
  const hwnd = CreateWindowExW()(
    0, 'Static', title,
    visible ? WS_OVERLAPPEDWINDOW : WS_POPUP,
    80, 80, width, height,
    null, null, null, null
  );
  if (!hwnd) throw new Error('CreateWindowExW 失败');
  return hwnd;
}

function destroyHostWindow(hwnd) {
  if (hwnd) DestroyWindow()(hwnd);
}

function showHostWindow(hwnd) {
  if (hwnd) ShowWindow()(hwnd, SW_RESTORE);
}

module.exports = { VideoSurface, createHostWindow, destroyHostWindow, showHostWindow, cursorPos, leftButtonDown, windowRect };
