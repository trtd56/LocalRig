# 評価スイート

LocalRig(Qwen 3.6 27B)と Claude Code (Sonnet) を同一タスク・同一検証条件で比較評価するためのスイート。
全20タスク。過去の実施結果と分析は [REPORT.md](REPORT.md) を参照。

## 前提

- **harness 側**: Ollama が起動しており `qwen36-27b-mtp:latest` が pull 済みであること
  (`curl -s http://localhost:11434/api/tags` で確認。`ollama show` は `:local` タグの解決に失敗するので `:latest` を使う)
- **baseline 側**: `claude` CLI にログイン済みであること(`--model sonnet --dangerously-skip-permissions` で起動される。API課金あり、全20タスクで $2〜3 程度)
- `bun` (このリポジトリの標準ランタイム)。type-repair タスクの verify は `bunx tsc` を使う(初回のみネットワークからダウンロード)

## 実行

```sh
bun run eval/run.ts --agent harness            # 全タスクをハーネスで
bun run eval/run.ts --agent claude             # 全タスクを Claude Code (Sonnet) で
bun run eval/run.ts --agent harness --task fix-bug,refactor   # タスク指定(カンマ区切り)
bun run eval/run.ts --agent harness --keep     # workdir を残して検分
```

- 結果は `eval/results/summary-<agent>.json` に**タスク単位でマージ**保存される(`--task` での部分再実行は該当タスクのエントリだけ更新し、他は保持)。エージェントの生ログは `eval/results/<agent>-<task>.log`
- `eval/results/` は gitignore 対象(実行結果はコミットしない)。スイート本体(tasks/・run.ts・REPORT.md)はコミットする
- 判定 = 「verify コマンドが exit 0」かつ「テストファイル非改ざん」の両方
- タスクごとの制限時間30分(ハーネスには `--max-time 1500` が渡り、SIGKILL 前に自力で切り上げる)。verify は120秒制限
- 所要時間の目安: claude 全20タスクで約18分、harness で約110分(タスク間で Ollama を専有するので他の重い処理と並走させない)

## ランナーの仕組みと落とし穴

- **テスト改ざん検出**: fixture コピー直後に「相対パスに `test` を含む全既存ファイル」の sha256 を記録し、終了後に不一致・削除があれば FAIL。エージェントが**新規作成**したファイルは対象外
- したがって fixture 設計時は: 保護したい資産(verify.sh、参照データ、ミュータント等)は `test/` 以下に置く。エージェントに変更させたいファイルのパスには `test` を含めない(**部分文字列**マッチなので `latest.ts` などもNG)
- ランナー保護の対象外だが変更されては困る資産(src の非改変性、ISSUE.md、tsconfig.json、新API側モジュール等)は、各タスクの verify.sh に sha256 を埋め込んで比較する(既存タスクの verify.sh にパターンあり)
- ログ解析で修復/fallback を grep する際、fixture 内の変数名 `fallback` に誤検知しないこと(実マーカーは「⚠ tool-call repair」等)
- **bun のテストタイムアウトは同期CPUバウンドコードをプリエンプトできない**(タイマーがイベントループに戻るまで発火しない)。性能ゲートが必要なら perf-fix のようにテスト内で `performance.now()` の経過時間をアサーションする

## タスク一覧(能力軸)

| タスク | 能力軸 |
|---|---|
| fix-bug | テスト駆動の単一バグ修正 |
| add-feature | 既存コードへの機能追加 |
| refactor | 重複ロジックのモジュール抽出 |
| hard-multi | 複合(2修正+1新規実装) |
| explore-codebase | 読み取り専用の探索QA |
| debug-runtime | 実行時エラーの診断修正 |
| api-migration | 横断API移行(3ファイル)+旧モジュール削除 |
| git-workflow | git 運用(init/コミット分割) |
| follow-conventions | CLAUDE.md 規約の遵守 |
| large-codebase | 36ファイルで3層下の根本原因特定 |
| test-triage | 独立3根本原因の切り分け |
| async-race | 並行処理バグ(決定的テスト) |
| spec-feature | SPEC.md 駆動のクエリ言語実装 |
| breaking-upgrade | 挙動変更(throw→Result)を伴う移行 |
| write-tests | テスト作成(ミューテーションテストで判定) |
| type-repair | 型エラー修復(`bunx tsc --noEmit`、any/ts-ignore 禁止) |
| doc-sync | README を実装に同期 |
| no-repro | 偽バグ報告への正直な「再現不能」報告(迎合バイアス検査) |
| perf-fix | 計算量改善(O(n²)→O(n)、経過時間アサーション) |
| rename-sweep | 12ファイル23箇所の機械的リネーム |

## 新タスク追加のプロトコル

1. `eval/tasks/<name>/task.json`(`name` / `prompt`(日本語・既存タスクの文体) / `verify` / `checks`(人間向けメモ、ランナーは解釈しない))と `eval/tasks/<name>/fixture/` を作成。fixture は依存ゼロ(node_modules なし・bun install 不要)
2. **三重検証を通してから採用する**:
   - pristine(未解決状態)の fixture コピーで verify が**失敗**する
   - リファレンス解を適用したコピーで verify が**成功**する(リファレンス解はコミットしない)
   - `bun run eval/run.ts --agent claude --task <name>` で Claude Code (Sonnet) が実際に解ける
3. 上記「ランナーの仕組みと落とし穴」の path 規約と sha256 埋め込みパターンに従う
