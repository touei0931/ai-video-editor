/**
 * BudouX の日本語パーサだけを取り込む。
 *
 * なぜ `import { loadDefaultJapaneseParser } from 'budoux'` としないか:
 *   budoux のエントリは日本語に加えてタイ語・中国語（簡体/繁体）のモデルと、
 *   HTML 処理用の `HTMLProcessingParser`（`linkedom` という DOM 実装に依存）を読み込む。
 *   これがツリーシェイクされず、レンダラのバンドルが 192KB → 412KB に増え、
 *   使わない DOM ライブラリまで同梱されていた（実測）。
 *
 *   テロップの改行に必要なのは「日本語モデル + パーサ」だけなので、
 *   exports マップを迂回して該当ファイルだけを直接読む。
 *
 * ⚠ 公開 API ではなく内部パスを参照しているので、budoux を更新するときは
 *   このファイルが壊れていないか確認すること（CI の T2 が検出する）。
 */
import { Parser } from '../../node_modules/budoux/module/parser.js';
import { model } from '../../node_modules/budoux/module/data/models/ja.js';

export interface JapaneseParser {
  parse(text: string): string[];
}

export const japaneseParser: JapaneseParser = new Parser(model);
