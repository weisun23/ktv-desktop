/**
 * 探针：验证 koffi 能否加载 libvlc.dll 并完成最小调用。
 * 这是 Node 路线的第一个未知数——过了才谈得上替代 Tauri。
 */
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');

const REPO = path.resolve(__dirname, '..', '..');
const VLC_DIR = path.join(REPO, 'resources', 'runtime', 'vlc', 'vlc-3.0.21');
const DLL = path.join(VLC_DIR, 'libvlc.dll');

if (!fs.existsSync(DLL)) {
  console.error('找不到 libvlc.dll:', DLL);
  process.exit(1);
}

// libvlc 需要能找到同目录的 libvlccore.dll
process.env.PATH = VLC_DIR + path.delimiter + process.env.PATH;
process.env.VLC_PLUGIN_PATH = path.join(VLC_DIR, 'plugins');

console.log('libvlc.dll =', DLL);

const lib = koffi.load(DLL);
console.log('load() ok');

const libvlc_get_version = lib.func('const char *libvlc_get_version()');
console.log('version =', libvlc_get_version());

const libvlc_new = lib.func('void *libvlc_new(int argc, const char **argv)');
const libvlc_release = lib.func('void libvlc_release(void *p_instance)');

const args = ['--quiet', '--no-video-title-show', '--plugin-path=' + path.join(VLC_DIR, 'plugins')];
const inst = libvlc_new(args.length, args);
if (!inst) { console.error('libvlc_new 返回 null'); process.exit(1); }
console.log('libvlc_new ok ->', inst);

libvlc_release(inst);
console.log('libvlc_release ok');
console.log('\n探针通过：koffi 可以驱动 libVLC');
