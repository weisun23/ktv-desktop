#!/usr/bin/env node
/**
 * 曲库安装 CLI
 * ============
 * 用法:
 *   node src/cli.js --manifest <清单路径或URL> --target <安装目录> [--force]
 *
 * 示例（从 maidong 的本地分片目录安装）:
 *   node src/cli.js --manifest <maidong-ktv-dir>\database_publish\database\manifest.json \
 *                   --target <repo>\resources\catalog
 */
'use strict';

const path = require('path');
const { installCatalog, human } = require('./install');

function parseArgs(argv) {
  const out = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest || !args.target) {
    console.log('用法: node src/cli.js --manifest <清单路径或URL> --target <安装目录> [--force]');
    return args.help ? 0 : 1;
  }

  let lastLine = '';
  const t0 = Date.now();
  const result = await installCatalog({
    // URL 不能走 path.resolve，否则会被当成相对路径拼成本地路径
    manifestSource: /^https?:\/\//i.test(args.manifest) ? args.manifest : path.resolve(args.manifest),
    targetDir: path.resolve(args.target),
    force: args.force,
    onProgress: ({ phase, percent, detail }) => {
      const line = `${phase.padEnd(9)} ${String(percent).padStart(3)}%  ${detail || ''}`;
      if (line !== lastLine) {
        process.stdout.write(`\r${line.padEnd(78)}`);
        lastLine = line;
      }
    },
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write('\n');
  console.log(result.skipped
    ? `已是版本 ${result.version}，跳过（${human(result.bytes)}）`
    : `安装完成：版本 ${result.version}，${human(result.bytes)}，用时 ${secs}s`);
  console.log(`数据库: ${result.dbPath}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('\n安装失败:', err.message);
  process.exit(1);
});
