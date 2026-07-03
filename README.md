# LocalRig

Ollama 上のローカル LLM(既定: Qwen 3.6 27B MTP)を Claude Code 級のコーディングエージェントとして動かすためのハーネス。

ローカルモデルの二大弱点 — **ツールコールの脆さ** と **コンテキスト管理の甘さ** — を、pi / OpenCode / qwen-code の実証済みテクニックを移植して補強している。設計の詳細と出典は [DESIGN.md](./DESIGN.md) を参照。

## 必要環境

- [Bun](https://bun.sh) ≥ 1.2(または Node.js ≥ 24)
- [Ollama](https://ollama.com)(モデル: `qwen36-27b-mtp:latest` など tools 対応モデル)

## インストール

```sh
bun install
bun link        # `localrig` / `lh` コマンドをグローバルに登録
```

## 使い方

```sh
localrig                  # 対話 REPL
localrig -p "タスク"       # ワンショット実行(進捗→stderr、最終回答→stdout)
echo "タスク" | localrig -p -  # stdin からプロンプトを渡す
localrig -p "タスク" --json    # 機械向け: JSON 1行を stdout に出力(下記参照)

# 既存連携向けに `lh` も同じCLIとして利用可能
lh -p "タスク"
```

| フラグ | 意味 |
|---|---|
| `-p "..."` | ワンショットモード(CI/スクリプト/エージェント向け)。`-p -` で stdin から読む |
| `--json` | 結果を JSON で出力し進捗を抑制(`-v` 併用で stderr に進捗) |
| `--quiet` | stderr への進捗表示を抑制 |
| `--cwd DIR` | 実行ディレクトリ指定 |
| `--model NAME` | モデル上書き(env: `LH_MODEL`) |
| `--num-ctx N` | コンテキスト窓(env: `LH_NUM_CTX`、既定 32768) |
| `--temperature T` | 既定 0.6(Qwen3.6 thinking 推奨値) |
| `--max-iterations N` | エージェントループ上限(既定 60) |
| `--auto` | 危険な bash コマンドのみ確認、他は自動承認(ワンショットでは確認できないため**拒否**になる。REPL では `/auto` でトグル) |
| `--yolo` | 全 mutating ツールを自動承認(ワンショットの既定) |
| `-v` | 詳細表示(ツール出力・トークン使用量) |

終了コード: `0` = 完了、`1` = 途中終了(ループ検出・上限到達・エラー)、`130` = 割り込み。

## Claude Code / Codex からの委譲とフィードバック

上位エージェント(Claude Code / Codex)が簡単なタスクをローカル LLM に投げてトークンを節約するための仕組み。ワンショット実行は毎回 `~/.localrig/sessions/` にセッションとして記録され、呼び出し側が検証後に採点を返せる。

```sh
lh -p "src/foo.ts の null チェック漏れを修正。bun test test/foo.test.ts が通ること" --json --cwd /path/to/repo
# → {"session_id":"20260703-141530-a1b2","status":"ok","result":"...","tokens":{...},"feedback_command":"lh feedback 20260703-141530-a1b2 <pass|fail> ..."}

# 呼び出し側が diff とテストで検証したあと採点(必須のプロトコル):
lh feedback 20260703-141530-a1b2 pass --source claude-code --notes "tests pass"
lh feedback 20260703-141530-a1b2 fail --source claude-code --notes "別ファイルを編集していた"

lh sessions        # 最近のセッション一覧(採点状況つき)
lh stats           # 委譲の合格率と直近の失敗ノート(委譲判断の較正に使う)
```

エージェント側の設定はコピーするだけ(詳細な手順・権限設定・トラブルシューティングは [integrations/SETUP.md](./integrations/SETUP.md)):

- **Claude Code**: `cp -r integrations/claude-code/delegate-local ~/.claude/skills/` — 委譲基準・検証・フィードバック必須のプロトコルを定義したスキル
- **Codex**: `integrations/codex/AGENTS-snippet.md` の内容を `~/.codex/AGENTS.md` に追記

データ置き場は env `LH_HOME` で変更可能(既定 `~/.localrig`)。

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
