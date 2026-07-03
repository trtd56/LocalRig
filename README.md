# localllm-harness

Ollama 上のローカル LLM(既定: Qwen 3.6 27B MTP)を Claude Code 級のコーディングエージェントとして動かすためのハーネス。

ローカルモデルの二大弱点 — **ツールコールの脆さ** と **コンテキスト管理の甘さ** — を、pi / OpenCode / qwen-code の実証済みテクニックを移植して補強している。設計の詳細と出典は [DESIGN.md](./DESIGN.md) を参照。

## 必要環境

- [Bun](https://bun.sh) ≥ 1.2(または Node.js ≥ 24)
- [Ollama](https://ollama.com)(モデル: `qwen36-27b-mtp:latest` など tools 対応モデル)

## 使い方

```sh
bun run src/index.ts                 # 対話 REPL
bun run src/index.ts -p "タスク"      # ワンショット実行(ツール自動承認)
bun run src/index.ts --model qwen36-27b-mtp:latest --num-ctx 32768 -v
```

| フラグ | 意味 |
|---|---|
| `-p "..."` | ワンショットモード(CI/スクリプト向け) |
| `--model NAME` | モデル上書き(env: `LH_MODEL`) |
| `--num-ctx N` | コンテキスト窓(env: `LH_NUM_CTX`、既定 32768) |
| `--temperature T` | 既定 0.6(Qwen3.6 thinking 推奨値) |
| `--auto` | 危険な bash コマンドのみ確認し、他の mutating ツールは自動承認(REPL では `/auto` でトグル) |
| `--yolo` | 全 mutating ツールを自動承認 |
| `-v` | 詳細表示(ツール出力・トークン使用量) |

## 主な強化ポイント

- **ツールコール修復パイプライン**: 名前のエイリアス/編集距離マッチ、二重エンコードJSONのアンラップ、引数キーの正規化、型強制。失敗はリクエストエラーにせず、修正方法を具体的に書いたツール結果としてモデルに返す
- **edit の多段マッチングカスケード**: exact → Unicode正規化 → 行トリム → エスケープ正規化 → ブロックアンカー。弱いモデルの空白・引用符の揺れを吸収
- **テキストフォールバックパーサ**: ネイティブ tool_calls が出ないターンでも `<tool_call>` JSON ブロックを回収
- **ループ検出**: 同一コール連続で警告→強制停止、空ターン検出、切断応答時の edit/write 拒否
- **段階的コンテキスト管理**: 実測トークン(prompt_eval_count)で校正した会計 → 75% で旧ツール出力をスタブ化 → 85% で構造化サマリへコンパクション(+機械的ファイルリスト)。Ollama のプレフィックス KV キャッシュを壊さない append-only 設計
- **todo の常時注入**: 変更時のみ末尾に再掲して 27B の脱線を防止

## テスト・評価

```sh
bun test                             # ユニットテスト
bun run eval/run.ts --agent harness  # 本ハーネス + ローカルモデルで評価タスク実行
bun run eval/run.ts --agent claude   # Claude Code (sonnet) ベースライン
```

評価は fixture を一時ディレクトリへコピーして実行し、タスク付属のテストで自動判定する(テストファイル改ざんはハッシュ比較で検出)。結果は `eval/results/` に保存。

### 評価タスク

Claude Code が日常的にこなす処理を能力軸ごとに分けてカバーする。

| タスク | 検証する能力 |
|---|---|
| `fix-bug` | 失敗テストからのバグ特定・修正 |
| `add-feature` | 既存コードへの仕様追加(テスト駆動) |
| `refactor` | 重複ロジックのモジュール抽出 |
| `hard-multi` | 複数バグ修正+新規モジュール実装の複合タスク |
| `explore-codebase` | コードベース探索・質問応答(grep/glob/read、読み取り専用) |
| `debug-runtime` | コマンド実行→スタックトレースからの実行時エラー診断 |
| `api-migration` | 非推奨APIの横断的な移行+旧モジュール削除 |
| `git-workflow` | git init/commit を含む bash 運用ワークフロー |
| `follow-conventions` | CLAUDE.md のプロジェクト規約を読んで遵守した実装 |

各タスクの合否は `test/verify.sh`(ハッシュ保護下)が判定する。テストが通るだけでは不十分なタスクもある — 例えば `follow-conventions` は規約違反(素の `Error` を throw、`// why:` コメント欠落)を grep で検出し、`debug-runtime` は入力データの改ざんをハッシュで拒否する。
