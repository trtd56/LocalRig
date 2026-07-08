# 評価スイート

LocalRig(Qwen 3.6 27B)と Claude Code (Sonnet) を同一タスク・同一検証条件で比較評価するためのスイート。
全29タスク。うち mass-migration は委譲コスト計測用に追加した重量級 fixture で、これまで claude / claude-delegate アームでのみ実測済み(harness 単体では未実測)。scout-locate / scout-honest は前処理 `lh scout` の評価用 fixture。incident-analysis / data-analysis / requirements-synthesis / config-audit は、コード変更を伴わない調査・分析・判断文書の評価用 fixture。ランナーは `eval/tasks/` を自動走査するので `--task` 無しの一括実行では harness アームでも実行対象に含まれる(ローカル推論が長い)——外したい場合は `--task` で対象を明示指定する。過去の実施結果と分析は [REPORT.md](REPORT.md) を参照。

## 前提

- **harness 側**: Ollama が起動しており `qwen36-27b-mtp:latest` が pull 済みであること
  (`curl -s http://localhost:11434/api/tags` で確認。`ollama show` は `:local` タグの解決に失敗するので `:latest` を使う)
- **baseline 側**: `claude` CLI にログイン済みであること(`--model sonnet --dangerously-skip-permissions` で起動される。API課金あり。旧21タスク構成の実測で $3 前後)
- `bun` (このリポジトリの標準ランタイム)。type-repair タスクの verify は `bunx tsc` を使う(初回のみネットワークからダウンロード)

## LLM不要の diff adapter 評価

parser と snapshot citation verifier の最低限の再現率は、モデルを起動せず決定的に確認できる。

```sh
bun run eval:diff-adapter
# expected=2, verified=2, fabricated citation dropped=1, recall=1
```

これは added/deleted 両側の location 保持と捏造quote除外だけを測る。`lh diff` の発火閾値（READMEの暫定500行/32KB）はまだ実モデル比較で校正していない。確定には同一diffレビュー課題で baseline と前処理アームを複数回走らせ、最終成功率、上位モデル総コスト、citation recall、圧縮率、壁時計を比較する。

## 実行

```sh
bun run eval/run.ts --agent harness            # 全タスクをハーネスで
bun run eval/run.ts --agent claude             # 全タスクを Claude Code (Sonnet) で
bun run eval/run.ts --agent harness --task fix-bug,refactor   # タスク指定(カンマ区切り)
bun run eval/run.ts --agent harness --task incident-analysis,data-analysis,requirements-synthesis,config-audit  # 非コーディング系のみ
bun run eval/run.ts --agent harness --keep     # workdir を残して検分
```

- 結果は `eval/results/summary-<agent>.json` に**タスク単位でマージ**保存される(`--task` での部分再実行は該当タスクのエントリだけ更新し、他は保持)。エージェントの生ログは `eval/results/<agent>-<task>.log`
- `eval/results/` は gitignore 対象(実行結果はコミットしない)。スイート本体(tasks/・run.ts・REPORT.md)はコミットする
- 判定 = 「verify コマンドが exit 0」かつ「テストファイル非改ざん」の両方
- タスクごとの制限時間30分(ハーネスには `--max-time 1500` が渡り、SIGKILL 前に自力で切り上げる)。verify は120秒制限
- 所要時間の過去実績: 旧構成では claude 21タスクで約20分、harness 20タスクで約110分。現在の29タスク構成は未計測で、mass-migration のローカル実行だけでも ~25分前後が加算される見込み。タスク間で Ollama を専有するので他の重い処理と並走させない
- summary の各エントリには `model` フィールドが記録される。harness アームは `LH_MODEL`(未設定なら `defaultConfig.model`)、claude 系アームはオーケストレータに渡している `--model` の値(現状 `sonnet` 固定)

## モデル更新時の回帰手順

ローカルモデル(現行 `qwen36-27b-mtp:latest`)を更新する際、既存タスクの合否・速度・トークン数が退行していないかを旧モデルの実測値と突き合わせて確認する。

1. `LH_MODEL` を新モデル名にして全タスクを harness アームで実行する(`eval/results/summary-harness.json` が上書き更新される):
   ```sh
   LH_MODEL=<新モデル名> bun run eval/run.ts --agent harness
   ```
2. `eval/compare-baseline.ts` で旧 baseline と diff を取る(タスク別の pass/fail・所要時間・promptTokens/completionTokens の差分を Markdown 表で標準出力):
   ```sh
   bun run eval/compare-baseline.ts --baseline eval/baselines/qwen36-27b-mtp.json --summary eval/results/summary-harness.json
   ```
3. 退行がなければ、新モデルの summary を `eval/baselines/<新モデル名>.json` として保存しコミットする(フォーマットは `eval/baselines/qwen36-27b-mtp.json` を参照: `{"model", "capturedAt", "note", "results"}` のラッパで、`results` は summary の配列をそのまま格納する)

## claude-delegate アーム(委譲による節約の計測)

Claude Code (Sonnet) が**自分で実装する**代わりに、ローカルの `lh` CLI に実装を**委譲**した場合、Claude 側の API コスト(トークン/ドル)がどれだけ減るかを計測するアーム。

```sh
bun run eval/run.ts --agent claude-delegate --task doc-sync           # 単一タスク
bun run eval/run.ts --agent claude-delegate --task doc-sync,fix-bug   # 複数指定
bun run eval/analyze-delegation.ts                                    # 比較レポート生成
```

- **プロンプトは baseline と同一**: タスク面のプロンプト(`spec.prompt`)は `claude` アームとバイト単位で同一。委譲の指示は `claude --append-system-prompt` にのみ注入される(`run.ts` の `DELEGATE_NUDGE` として export、調整はここを編集)。両アームが同じ指示・同じタスクを解くので比較可能
- **セッションの隔離**: 各タスクの委譲セッションは `eval/results/lh-home/<task>/` を `LH_HOME` として実行される(workdir 削除後も残り、ユーザーの実 `~/.localrig` を汚染しない)。タスク実行ごとに冒頭で wipe されるので前回の残骸は混入しない。Bash ツールの待ち時間上限も広げる(`BASH_MAX_TIMEOUT_MS`/`BASH_DEFAULT_TIMEOUT_MS`)
- **制限時間はタスクあたり40分**(ローカルモデルの実行時間 + Claude のオーケストレーション/検証を見込む。他アームは30分)
- **収集する指標**: baseline の claude アーム同様 `costUsd`(`total_cost_usd`)と `usage` 内訳(input/cacheRead/cacheCreation/output)を summary に取り込む。加えてローカル側を `LH_HOME` から回収し、`delegated`(委譲したか)・`delegations`(session ごとの status/turns/toolCalls/tokens/duration)・`feedback`(claude が記録した pass/fail 判定)を summary エントリに付与する
- **分析**: `eval/analyze-delegation.ts` が `summary-claude.json`(baseline)と `summary-claude-delegate.json` を突き合わせ、タスク別表(pass・Claude コスト base→deleg と節約率・出力/プロンプトトークン・turns・実時間・委譲有無・ローカル側トークン/時間)と集計・注意書きを Markdown で `eval/results/delegation-comparison.md` に出力(標準出力にも同内容)。baseline の古いエントリで `costUsd` が無い場合は生ログ `claude-<task>.log` から `total_cost_usd` をフォールバック抽出する
- **主指標はドルコスト**。プロンプトトークンはキャッシュ read/creation を含むため実プロンプトサイズを過大表示し、コストと比例しない(詳細はレポートの caveats 節)
- 実施結果と分析は [REPORT.md](REPORT.md) の「委譲検証(2026-07-06、claude-delegate アーム)」節を参照(6タスク中3タスクのみ委譲、集計 $1.053→$0.857 = −19%、委譲は可変コストを ~$0.11〜0.13 の固定オーケストレーションコストに変換するため損益分岐 ≈ $0.13〜0.15)

### Haiku ワーカー対照アーム(claude-delegate-haiku)

`claude-delegate` の「委譲構造そのもののコスト」と「ローカルLLM(Qwen)の品質・遅延」を切り分けるための対照アーム。オーケストレータは同じ Sonnet(`spec.prompt` はバイト同一、指示は `HAIKU_DELEGATE_NUDGE` を `--append-system-prompt` で注入)だが、ワーカーを無料のローカル `lh` ではなく **`claude --model haiku`(課金される)** に差し替える。ワーカーは作業結果を `<workdir>/.delegate/worker-N.json` に書き、ランナーが workdir 削除前に `eval/results/delegate-workers/<task>/` へ退避して `total_cost_usd`/`is_error` 等を summary の `workers[]` に取り込む。

```sh
bun run eval/run.ts --agent claude-delegate-haiku --task doc-sync
bun run eval/analyze-delegation.ts   # summary-claude-delegate-haiku.json があれば自動で3-way比較
```

- **ワーカーはフォアグラウンド実行必須**: `HAIKU_DELEGATE_NUDGE` はワーカーの `claude` を `< /dev/null` + Bash タイムアウト 600000ms で**フォアグラウンド**起動するよう指示する。この環境ではバックグラウンド実行したネスト claude は**静かに起動失敗**する(task は "running" のままプロセス不在、パイロットで 40 分 SIGKILL を2回誘発してから判明)ため
- 委譲判定は `delegated = workers.length > 0`。機械的バックアップとして `~/.claude/projects/<workdir実パスのスラグ>/` 内の(オーケストレータ自身の session_id 以外の)session 数を数え `workerSessions` に記録する。LH_HOME は `eval/results/lh-home/<task>-haiku/` に隔離され**空のままが正常**——ここに `lh` セッションが出たらオーケストレータが誤ってローカルへ委譲した混入(`delegations[]` に現れ、レポートで `⚠ lh contamination` と表示)
- `analyze-delegation.ts` は 3アーム比較(baseline / lh-delegate / haiku-delegate)に切り替わり、haiku 側は**オーケストレータのみのコスト**と**オーケストレータ+ワーカーの課金総額**の両方を出す(lh ワーカーは無料だが haiku ワーカーは課金される)。H1(固定オーケストレーション床の検証: haiku のオーケストレータのみコスト vs lh コスト)/H2(ワーカー品質: 合格率)/H3(実時間: 3アーム比較)の仮説セクション付き。haiku の summary が無ければ従来の 2-way 出力のまま

### claude-delegate-async アーム(submit/wait 非同期委譲の効果計測)

同期版 `claude-delegate` が `lh -p -` でブロックするのに対し、`lh submit`(即座に session_id を返す)→ 検証準備 → `lh wait` の非同期パターンに差し替え、**呼び出し元のブロック時間が縮むか**を測るアーム。委譲第一/フォアグラウンド/`--check`/`lh feedback` の契約は同期版と同一で、指示は `ASYNC_DELEGATE_NUDGE` を `--append-system-prompt` で注入する。

```sh
bun run eval/run.ts --agent claude-delegate-async --task rename-sweep
```

- 出力先はアームごとに分離される: summary は `eval/results/summary-claude-delegate-async.json`、LH_HOME は `eval/results/lh-home/<task>-async/`(同期版の `<task>` / haiku 版の `<task>-haiku` と衝突しない)。生ログは `eval/results/claude-delegate-async-<task>.log`
- `analyze-delegation.ts` の 3アーム比較(baseline / lh-delegate / haiku)には**含まれない**——非同期アームはブロック時間の計測が目的で、コスト比較は同期版で足りるため
- **実測サマリ**: 単一タスクの headless 設定では submit/wait は実効ブロック時間を縮めず、むしろターン増でコスト +33%(**負の結果**)。トランスクリプトのタイムライン証跡と限定条件は [REPORT.md](REPORT.md) の「委譲検証」第4ラウンド・課題1 を参照

## claude-scout アーム(読み取り前処理の計測)

Claude Code (Sonnet) がリポジトリ横断の探索を自力 grep/read する代わりに、先に `lh scout` で citation-checked digest を作らせる前処理アーム。タスク面のプロンプトは baseline の `claude` と同一で、scout 利用指示は `SCOUT_NUDGE` を `--append-system-prompt` で注入する。

```sh
bun run eval/run.ts --agent claude --task scout-locate,scout-honest
bun run eval/run.ts --agent claude-scout --task scout-locate,scout-honest
```

- `LH_HOME` は `eval/results/lh-home/<task>-scout/` に隔離され、scout セッションの有無で nudge 遵守を機械判定する。summary には既存の `delegated` / `delegations` / `feedback` 欄を流用して、scout セッションの status/turns/toolCalls/tokens/duration と feedback に加え、digest の `not_found` / `citations_dropped` / citation count / cited files / fixture別 citation recall を保存する。
- `scout-locate` は定義・登録・呼び出し元が複数ファイルに分散する所在調査、`scout-honest` は存在しない機能を `not_found` と言えるかの迎合検査。acceptance は `ANSWER.md` の内容と `src/` の sha256 不変性で機械判定する。`claude-scout` では scout digest 自体の品質ゲートもかけ、`scout-honest` の not_found 不正や `dropped>0 && not_found=false`、`scout-locate` の recall < 2/3 を FAIL として記録する。
- 比較対象は同日・同 CLI バージョン・warm 統制の `claude` baseline。見る指標は PASS、Claude cost、壁時計、scout 遵守率、scout セッション側の citation drop / feedback。

P2 の n=3 測定では `--run-id` を付けると summary を上書きせず保存できる:

```sh
bun run eval/run.ts --agent claude --task scout-locate --run-id p2-r1
bun run eval/run.ts --agent claude-scout --task scout-locate --run-id p2-r1
bun run eval/run.ts --agent claude --task scout-locate --run-id p2-r2
bun run eval/run.ts --agent claude-scout --task scout-locate --run-id p2-r2
bun run eval/run.ts --agent claude --task scout-locate --run-id p2-r3
bun run eval/run.ts --agent claude-scout --task scout-locate --run-id p2-r3
bun run eval/analyze-preprocess.ts --baseline-agent claude --arm-agent claude-scout --task scout-locate
```

`analyze-preprocess.ts` は `summary-<agent>.json` と `summary-<agent>.<run-id>.json` を集め、中央値 cost/壁時計、前処理遵守率、citation recall/drop、品質 FAIL 数を `eval/results/preprocess-comparison.md` に出す。

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
| mass-migration | 40ファイル46箇所の重量級API移行(委譲コスト計測用。source の正解値はパス導出不能でコメント内にのみ存在=単一sed耐性) |
| batch-trio | docs・型修正・性能改善の独立3タスクをまとめたバッチ委譲 |
| async-pair | 機械的移行と独立した設計メモを組み合わせた非同期委譲計測 |
| scout-locate | 読み取り専用の所在調査(定義・登録・呼び出し元の分散探索) |
| scout-honest | 存在しない機能に not_found と答える前処理版の迎合検査 |
| incident-analysis | 複数ログ・デプロイ履歴・runbookを突き合わせる障害一次調査 |
| data-analysis | 重複・除外規則・返金を含むCSVの集計とデータ品質説明 |
| requirements-synthesis | 優先順位の異なる要求文書の競合解消と未決事項の保持 |
| config-audit | 本番ポリシーに基づく設定監査・優先順位付け・是正提案 |

## 新タスク追加のプロトコル

1. `eval/tasks/<name>/task.json`(`name` / `prompt`(日本語・既存タスクの文体) / `verify` / `checks`(人間向けメモ、ランナーは解釈しない))と `eval/tasks/<name>/fixture/` を作成。fixture は依存ゼロ(node_modules なし・bun install 不要)
2. **三重検証を通してから採用する**:
   - pristine(未解決状態)の fixture コピーで verify が**失敗**する
   - リファレンス解を適用したコピーで verify が**成功**する(リファレンス解はコミットしない)
   - `bun run eval/run.ts --agent claude --task <name>` で Claude Code (Sonnet) が実際に解ける
3. 上記「ランナーの仕組みと落とし穴」の path 規約と sha256 埋め込みパターンに従う
