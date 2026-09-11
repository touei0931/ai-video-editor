/**
 * ② 設定。動画を選んだあと、解析を始める前に決めることを並べる。
 *
 * 🔴 FCP プラグイン版の「② 設定」と同じ項目・同じ言葉にすること。
 *    以前のアプリ版は動画を選ぶと**すぐ解析が始まり**、言語も精度も
 *    口ぐせも決められなかった。プラグイン版で友達が使い慣れた設定が
 *    こちらには無い状態だった。
 *
 * 🔴 モデルの選択は「初回だけ大きなダウンロードが走る」ことを必ず見せる。
 *    何分も無反応に見えると、壊れたと思って強制終了される。
 */

import {
  EXPORT_SPEED_RANGE,
  LANGUAGES,
  MODELS,
  PACE_PRESETS,
  clampSpeed,
  type AnalyzeLanguage,
  type AnalyzeSettings,
  type AsrModel,
} from './analyzeSettings';
import type { PacePreset } from './review/ReviewScreen';

interface Props {
  videoPath: string;
  settings: AnalyzeSettings;
  onChange(patch: Partial<AnalyzeSettings>): void;
  onBack(): void;
  onStart(): void;
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export function AnalyzeSettingsScreen({ videoPath, settings, onChange, onBack, onStart }: Props) {
  const model = MODELS.find((m) => m.name === settings.model);
  const pace = PACE_PRESETS.find((p) => p.name === settings.pace);

  return (
    <main>
      <h1>PAC</h1>
      <p className="phase">
        ② 設定 — 解析を始める前に決めることです。迷ったら初期値のままで大丈夫です
        <br />
        素材：
        <strong className="settings-value" title={videoPath}>
          {fileName(videoPath)}
        </strong>
      </p>

      <div className="settings-grid">
        <section>
          <h2>話している言語</h2>
          <select
            value={settings.language}
            onChange={(e) => onChange({ language: e.target.value as AnalyzeLanguage })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <p className="muted">決め打ちにしたほうが精度が上がります。迷ったら「日本語」のままで大丈夫です。</p>
        </section>

        <section>
          <h2>文字起こしの精度</h2>
          <select
            value={settings.model}
            onChange={(e) => onChange({ model: e.target.value as AsrModel })}
          >
            {MODELS.map((m) => (
              <option key={m.name} value={m.name}>
                {m.label}
              </option>
            ))}
          </select>
          {model && (
            <p className="muted">
              {model.description}
              <br />
              <span className="warn">
                初回のみ約 {model.downloadSize} のダウンロードが走ります（2回目以降はありません）
              </span>
            </p>
          )}
        </section>

        <section>
          <h2>カットの詰め具合</h2>
          <select
            value={settings.pace}
            onChange={(e) => onChange({ pace: e.target.value as PacePreset })}
          >
            {PACE_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}
              </option>
            ))}
          </select>
          {pace && <p className="muted">{pace.description}</p>}
          <p className="muted">
            ここで決まるのは「どこを候補に挙げるか」だけです。切るかどうかは「カット」の画面で
            1件ずつ選べます。
            <br />
            <span className="faint">※ 解析のあとでも「カット」の画面で変えられます（解析はやり直しません）</span>
          </p>
        </section>

        <section>
          <h2>独り言も候補にする</h2>
          <label className="inline">
            <input
              type="checkbox"
              checked={settings.detectAside}
              onChange={(e) => onChange({ detectAside: e.target.checked })}
            />
            <span>話が繋がっていない所を探す</span>
          </label>
          <p className="muted">
            「あれ、止まってない？」「もう一回」のような、話の本筋と繋がっていないひとりごとを
            候補に挙げます。無音でもフィラーでもないので、今までどれにも引っかかりませんでした。
            <br />
            見ているのは<strong>前後と同じ話題の語を使っているか</strong>・
            <strong>ぽつんと孤立しているか</strong>・<strong>撮り直しの言い回しか</strong>
            の3つで、話の意味そのものは読んでいません。外すこともあるので、切るかどうかは必ず
            「カット」の画面で1件ずつ決めてください（勝手に切ることはありません）。
          </p>
        </section>

        <section>
          <h2>自分の口ぐせ</h2>
          <textarea
            rows={2}
            value={settings.extraFillers}
            placeholder="ですね、まあまあ、なんていうか"
            onChange={(e) => onChange({ extraFillers: e.target.value })}
          />
          <p className="muted">
            ここに書いた言葉も「フィラー」として候補に挙げます。
            読点・空白・改行のどれで区切ってもかまいません。
            <br />
            「えー」「あのー」「えっと」「なんか」などは<strong>最初から入っています</strong>ので、
            それ以外の自分の癖だけ書いてください。
          </p>
        </section>

        <section>
          <h2>書き出す再生速度</h2>
          <div className="inline">
            <input
              type="number"
              min={EXPORT_SPEED_RANGE.min}
              max={EXPORT_SPEED_RANGE.max}
              step={5}
              value={Math.round(settings.exportSpeed * 100)}
              onChange={(e) => {
                const n = Number(e.target.value);
                // 🔴 打ちかけの空欄で弾かないこと。「1」を消して「120」に打ち直す途中で戻されると入力できない
                if (!Number.isFinite(n)) return;
                onChange({ exportSpeed: n / 100 });
              }}
              onBlur={(e) => onChange({ exportSpeed: clampSpeed(Number(e.target.value) / 100) })}
              style={{ width: 90 }}
            />
            <span className="muted">％（100 で等倍）</span>
          </div>
          <p className="muted">
            <strong>あとで速度を変えると、テロップの位置がずれます。</strong>
            ここで指定しておけば、テロップも一緒に付いてきます。
            <br />
            120 なら 1.2倍速。素材そのものには手を加えず、書き出す動画・字幕・Final Cut 用の
            タイムラインの速度だけが変わります。
            <br />
            <span className="faint">※ 解析には関係しません。書き出しの画面でも変えられます</span>
          </p>
        </section>
      </div>

      <div className="actions">
        <button onClick={onBack}>戻る</button>
        <button className="primary" onClick={onStart}>
          解析を始める
        </button>
      </div>
    </main>
  );
}
