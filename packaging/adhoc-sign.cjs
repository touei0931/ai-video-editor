// electron-builder の afterPack フック。.app を「アドホック署名」する。
//
// なぜ要るか:
//   Apple Silicon (arm64) では、署名の無い実行ファイルはカーネルが実行を拒否する。
//   Intel の頃は未署名でも動いたので見落としやすい。未署名のまま配ると、
//   受け取った側には「"PAC" は壊れているため開けません。ゴミ箱に入れる必要があります。」
//   と出る。壊れているのではなく、署名が無い（か壊れている）だけ。
//
// アドホック署名 (`codesign --sign -`) は Apple の開発者アカウント($99/年)が要らない。
// これで「実行できない」は消える。ただし Apple の公証は受けていないので、
// 初回に Gatekeeper の警告は出る（docs/はじめての使い方.md の手順で開ける）。
//
// 🔴 package.json の mac.identity は null のまま（electron-builder 自身の署名は使わない）。
//    署名はここで一手にやる。両方が動くと二重署名で壊れる。

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { existsSync } = require('node:fs');

// Resources に直に置いてあり、アプリから起動される実行ファイル。
// --deep でも拾われるはずだが、動かないと解析が丸ごと失敗する箇所なので先に個別に署名する。
const LOOSE_BINARIES = [
  'sidecar/sidecar',
  'ffmpeg/ffmpeg',
  'ffmpeg/ffprobe',
];

function run(args) {
  return execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!existsSync(app)) throw new Error(`署名する .app が見つからない: ${app}`);

  const resources = join(app, 'Contents', 'Resources');
  for (const rel of LOOSE_BINARIES) {
    const bin = join(resources, rel);
    if (!existsSync(bin)) throw new Error(`同梱されているはずの実行ファイルが無い: ${rel}`);
    run(['--force', '--sign', '-', '--timestamp=none', bin]);
  }
  console.log(`  ✓ 中の実行ファイル ${LOOSE_BINARIES.length} 件に署名`);

  // --deep は Apple が非推奨としているが、入れ子(Framework/Helper/1000超のdylib)を
  // 下から順に自前で辿るより事故が少ない。公証しない配布なのでこれで足りる。
  run(['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
  console.log('  ✓ アプリ本体に署名');

  // 署名したつもりで出来ていない、を通さない。
  run(['--verify', '--deep', '--strict', app]);
  const info = execFileSync('codesign', ['-dv', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .toString();
  const stderr = (() => {
    try {
      return execFileSync('sh', ['-c', `codesign -dv "${app}" 2>&1`], { encoding: 'utf8' });
    } catch {
      return info;
    }
  })();
  if (!/Signature=adhoc/.test(stderr)) {
    throw new Error(`アドホック署名になっていない:\n${stderr}`);
  }
  console.log('  ✓ 署名を検証（Signature=adhoc）');
}

module.exports = adhocSign;
module.exports.default = adhocSign;
