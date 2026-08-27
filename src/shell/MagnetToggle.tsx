/**
 * 磁石の入り切り。
 *
 * 「マグネティックタイムライン」（本編のクリップを隙間なく詰める）と
 * 「吸着」（掴んだ端を近くの切れ目に吸い付ける）は別のはたらきだが、
 * どちらも**磁石のたとえ**で説明できるので、見た目は揃える。
 * 何のはたらきかは title（カーソルを載せたときの説明）で分ける。
 *
 * 🔴 字を置かないこと。
 *    ここはタイムラインの見出しに並ぶ添え物で、主役ではない。
 *    「詰める」「吸着」と書くと、その2文字ぶん見出しが横に伸びるうえ、
 *    となりの「再生地点」などと同じ重さに見えてしまう。
 *    絵なら一目で入り切りが分かり、意味はカーソルを載せれば読める。
 *
 * 🔴 入り切りは**色**で見せること。枠の濃さだけだと、
 *    どちらの状態なのかが画面から読み取れない。
 *    入＝青（このアプリで「効いている」を表す色）、切＝白。
 */

interface MagnetToggleProps {
  /** 効いているか */
  on: boolean;
  onToggle: () => void;
  /** カーソルを載せたときの説明。何のはたらきかはここで分ける */
  title: string;
  /** 読み上げ用の名前。目には見えない */
  label: string;
}

export function MagnetToggle({ on, onToggle, title, label }: MagnetToggleProps) {
  return (
    <button
      type="button"
      className={`fcp-magnet ${on ? 'on' : ''}`}
      onClick={onToggle}
      title={title}
      aria-label={label}
      aria-pressed={on}
    >
      {/*
        馬蹄形の磁石。上が弧、下が2本の脚。
        🔴 脚の先を胴と分けて描くこと。ただの U 字だと磁石に見えない。
           胴を先端の手前で止めて、その先を薄い色で継ぐ（重ねない）。
      */}
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="none" strokeWidth="3.6" strokeLinecap="butt">
          <path d="M5.6 16.8V11a6.4 6.4 0 0 1 12.8 0v5.8" stroke="currentColor" />
          <path d="M5.6 16.8v2.6M18.4 16.8v2.6" stroke="currentColor" opacity="0.45" />
        </g>
      </svg>
    </button>
  );
}
