# 比較評価レポート: LocalRig (Qwen 3.6 27B) vs Claude Code (Sonnet)

実施日: 2026-07-03 / 環境: macOS (Darwin 23.6.0), 64GB RAM, Ollama 0.30.6
ハーネス設定: `qwen36-27b-mtp:latest` (Q4_K_S), num_ctx 65536, temp 0.6 / top_p 0.95 / top_k 20
ベースライン: `claude -p --model sonnet --dangerously-skip-permissions` (Claude Code 2.1.199)

同一プロンプト・同一fixture・同一検証コマンドで実行。判定は (a) タスク付属テスト全通過、(b) テストファイル非改ざん(SHA-256比較) の両方を満たすこと。

## 結果

| タスク | 内容 | ハーネス (Qwen3.6) | Claude Code (Sonnet) |
|---|---|---|---|
| fix-bug | median のミューテーション+偶数長バグ修正 | **PASS** 76s | **PASS** 43s |
| add-feature | formatOutput への JSON 出力追加 | **PASS** 77s | **PASS** 37s |
| refactor | 重複バリデーションの新モジュール抽出(3ファイル) | **PASS** 177s | **PASS** 64s |
| hard-multi | 非同期バグ(forEach+async)+off-by-one 修正+新モジュール実装の複合 | **PASS** 178s | **PASS** 38s |
| **成功率** | | **4/4 (100%)** | **4/4 (100%)** |

## 品質シグナル(ハーネス側ログ分析)

- ツールコール修復の発動: **0回**(全コールがネイティブ形式で整形済み — 修復パイプラインは保険として機能)
- ツール実行失敗・ループ警告: **0回**
- ツールコール数: fix-bug 6 / add-feature 5 / refactor 17 / hard-multi 14(探索→編集→検証の無駄のない軌跡)
- hard-multi の作業パターン: todo計画 → read×5+glob で探索 → edit×2+write → bun test で検証 → todo完了 → 3修正を正確に説明する最終サマリ。Claude Code と同質の行動様式
- 全タスクでテスト改ざんなし、検証(bun test)を自発的に実行してから完了報告

## 結論

このタスクセット(単機能修正〜複合マルチファイル作業)では、**ハーネス+Qwen 3.6 27B は Claude Code (Sonnet) と同等の成果物品質を達成**。差は所要時間のみで、ローカル推論のため約2〜4.7倍(それでも全タスク3分以内)。

### 留意点

- タスク規模は小〜中(fixture 2〜6ファイル)。大規模リポジトリでの長時間セッションはコンテキスト管理(prune/compact)の実地検証がまだ薄い(ユニットテストでは検証済み)
- 4タスクではネイティブツールコールが常に整形済みだったため、修復・fallback 経路は実運用での発動頻度が未計測
- 再現: `bun run eval/run.ts --agent harness` / `--agent claude`(summary は実行ごとに上書きされる点に注意)

## 前処理検証 第0ラウンド (`lh distill` 実装)

2026-07-08 に `lh distill` のP0実装を追加した。これは委譲と違い、作業をローカルLLMへ任せるのではなく、数千行以上のログ/ファイルを上位エージェントへ渡す前に citation 付き digest へ圧縮する前処理レイヤーである。

実装済み:
- `src/distill.ts`: ファイル境界優先/行分割のチャンク計画、digest JSON parse、citation の完全一致→近傍±20行→全体探索による機械照合、幻覚引用 drop、map-reduce。
- `lh distill -q "<query>" [files...]`: stdin対応、`--budget`、`--think`、`--json`、セッション保存、`kind=distill` の feedback/stats 連携。
- Ollama `complete()` の JSON schema `format` 透過と非stream token usage 集計。
- ユニット/CLI DI テスト追加。現時点の全体テストは `bun test test/` で 312/312 PASS。

未実測:
- P0計画のプリフィル tok/s 計測、`distill-log-triage` / `distill-recall-needle` fixture、`claude-distill` アームは未追加。したがって citation precision は実装上 drop により担保される一方、recall と実コスト削減はまだ評価前。

## 前処理検証 第1ラウンド (`lh scout` 実装)

2026-07-08 に `lh scout` のP1実装を追加した。`distill` が「読む入力が分かっている」場合の圧縮であるのに対し、`scout` は読む場所の探索からローカルに任せる read-only 前処理である。

実装済み:
- `Agent` に省略可能な tool set 注入と thinking 強制フックを追加。既存呼び出しは未指定なら従来どおり全ツール。
- `createScoutTools(config)` は `read` / `grep` / `glob` のみを返し、`bash` / `write` / `edit` / `todo` を渡さない。
- `buildScoutSystemPrompt(...)` は探索手順、`not_found` 規約、distill と同型の digest JSON 契約を明示。
- `lh scout -q "<query>" [--paths ...] --json`: scout 専用 Agent 実行、最終 JSON の修復リトライ1回、`parseDigest`/`verifyCitations` による citation 照合、`parse_failed` フォールバック、セッション保存、`kind=scout` の feedback/stats 連携。`--resume` / `submit` は拒否。
- eval に `claude-scout` アームと `SCOUT_NUDGE` を追加。`LH_HOME` を `eval/results/lh-home/<task>-scout/` に隔離し、scout セッションの有無で nudge 遵守を機械判定する。
- eval fixture `scout-locate` / `scout-honest` を追加。前者は複数ファイルに分散した定義・登録・呼び出し元の所在調査、後者は存在しない機能を正直に not_found と答える迎合検査。両 fixture は `ANSWER.md` に加えて `src/` の sha256 不変性も verify する。
- eval summary の scout セッションには digest の `not_found` / `citations_dropped` / citation count / cited files / fixture別 citation recall を保存する。`scout-honest` の not_found 不正や `dropped>0 && not_found=false`、`scout-locate` の recall < 2/3 は `preprocessQualityFailed` として FAIL に落とす。
- 素の `lh scout` は明示指定がなければ `max_iterations=20` / `max_time=900s` を適用し、通常の委譲より小さい探索予算にした。

検証:
- `bun test test/`: 333/333 PASS
- `bunx tsc --noEmit`: clean

未実測:
- P1計画の実モデル smoke(P1-0)、`scout-locate` / `scout-honest` の `claude` vs `claude-scout` 同日比較、thinking on/off 差、citation recall / dropped の集計は未実行。したがって機能は実装済みだが、scout が「何ファイル以上読む質問で黒字か」の損益分岐はまだ REPORT に数値化していない。

## 前処理検証 第2ラウンド(P2 統合深化の足場)

2026-07-08 に P2 のうち、実測を受けて規則化するための機械的な足場を追加した。今回の変更は実モデルの n=3 測定そのものではなく、測定値と feedback を上位エージェントの判断に安定して接続する実装である。

- `lh stats --by-kind --json` の各 kind に `gate` を追加した。現行ゲートは `graded >= 3` かつ pass `rate < 50` で `gate.status:"block"`、それ未満は `insufficient_data`、閾値以上で pass rate が足りれば `allow`。委譲だけでなく `distill` / `scout` kind にも同一規則を適用する。
- P2 の暫定発火条件を docs / skills / AGENTS snippet に同期した: `distill` は「既知入力が 1000行以上または64KB以上で、意味的選別が必要」、`scout` は「所在調査で5ファイル以上読む見込み」。どちらも `gate.status:"block"` なら使わない。
- eval runner に `--run-id` を追加し、`summary-<agent>.<run-id>.json` を保存できるようにした。P2-4 の同日 n=3 測定で既存 summary を上書きしないため。
- `eval/analyze-preprocess.ts` を追加した。baseline と前処理アームの複数 summary から median cost / median wall / 前処理遵守率 / citation recall / citation drop / preprocess quality fail を Markdown へ集計する。
- Claude Code hook 案として `integrations/claude-code/hooks/distill-read-guard.js` を追加した。PreToolUse の `Read` に対し、64KBかつ1000行以上の全体 Read は hard block ではなく `ask` にして `lh distill` を促す。`offset`/`limit` 付きの220行以下の precise read は通すため、digest の cited range 確認を妨げない設計。

未完了:

- P0/P1 の同日・同CLIバージョン・warm統制 n=3 測定は未実施。よって 1000行/64KB と 5ファイルは暫定の運用閾値であり、実測から導いた確定損益分岐ではない。
- `distill-log-triage` / `distill-recall-needle` と `claude-distill` アームはまだ存在しないため、distill 側の見出しセルは測れない。

## 第2回評価: 能力軸別9タスク(2026-07-03)

Claude Code の行動様式を能力軸ごとに検証する5タスク(explore-codebase / debug-runtime / api-migration / git-workflow / follow-conventions)を追加し、全9タスクをハーネスで一括実行。**9/9 PASS、総所要 22分03秒**。

| タスク | 結果 | 所要 | ツールコール数 |
|---|---|---|---|
| add-feature | **PASS** | 61s | 4 |
| api-migration | **PASS** | 234s | 20 |
| debug-runtime | **PASS** | 79s | 5 |
| explore-codebase | **PASS** | 78s | 5 |
| fix-bug | **PASS** | 147s | 8 |
| follow-conventions | **PASS** | 82s | 6 |
| git-workflow | **PASS** | 243s | 18 |
| hard-multi | **PASS** | 210s | 14 |
| refactor | **PASS** | 189s | 14 |

### 品質シグナル(ログ分析)

- ツールコール修復・fallback・ループ警告の発動: **0回**(初回評価と同じく全コールがネイティブ形式で整形済み)
- explore-codebase: デコイの再エクスポートファイル(`src/core/priorities.ts`)を「定義ではない」と正しく判別して正答
- debug-runtime: 最初にコマンドを実行して TypeError を観測 → データを読んで「metadata 無し/空 metadata」の両ケースを特定 → 修正、の理想的な診断手順(5コール)
- api-migration: todo計画 → glob+read×6 で全呼び出し元を列挙 → 3ファイル×2段階の edit → `rm` で旧モジュール削除 → bun test 検証
- git-workflow: initial コミット → テスト実行で失敗観測 → 修正 → fix コミットの2コミット構成を指示通り再現、ワーキングツリーもクリーン
- follow-conventions: 実装前に CLAUDE.md と src/errors.ts を自発的に read し、`// why:` コメント+ AppError の両規約を遵守

### 結論(第2回)

テスト駆動の修正だけでなく、**読み取り専用の探索QA・実行時エラー診断・横断移行・git運用・プロジェクト規約遵守という Claude Code 的な行動様式の全軸で合格**。重量級タスク(api-migration 234s / git-workflow 243s)でも探索→編集→検証の軌跡に無駄がなく、修復系セーフティネットの発動はゼロだった。

## 第3回評価: 高難度5タスク(2026-07-03)

第1〜2回で未検証だった領域(大規模コードベース探索・仕様書駆動の長工程実装・複数根本原因の切り分け・挙動変更を伴う移行・並行処理バグ)を突く5タスクを追加し、計14タスク構成にした。新タスクは Opus/Sonnet のサブエージェントが fixture を作成し、各 fixture について (1) 未解決状態で verify が失敗、(2) リファレンス解で verify が成功、(3) Claude Code (Sonnet) が実際に解ける、の三重検証を通してから採用した。

| タスク | 内容 | ハーネス (Qwen3.6) | Claude Code (Sonnet) | ツールコール | prune / compact |
|---|---|---|---|---|---|
| large-codebase | 36ファイルの階層化コードベースで、統合テスト失敗から3層下の共有ユーティリティのバグを特定(デコイ4種入り) | **PASS** 134s | **PASS** 49s | 6 | 0 / 0 |
| test-triage | 独立した3根本原因による6テスト失敗の切り分け(カスケード失敗含む) | **PASS** 425s | **PASS** 45s | 26 | 4 / 0 |
| async-race | AsyncCache の in-flight 重複と stale write(並行時のみ発症、決定的テスト) | **PASS** 903s | **PASS** 101s | 14 | 2 / 1 |
| spec-feature | SPEC.md の検索クエリ言語(status/tag/否定/フレーズ/エラー系)を2モジュール新規実装 | **PASS** 908s | **PASS** 79s | 21 | 5 / 0 |
| breaking-upgrade | throw→Result型への挙動変更を伴う内部ライブラリv2移行(5ファイル)+v1削除 | **PASS** 1800s ※ | **PASS** 127s | 50 | 15 / 1 |
| **成功率** | | **5/5 (100%)** | **5/5 (100%)** | | |

※ breaking-upgrade は移行完了・全16テスト通過・v1削除まで終えた後、最終サマリの生成中に30分タイムアウトで kill された(verify は成果物で判定するため PASS は正当)。

### 品質シグナル(ログ分析)

- ツールコール修復・fallback・ループ警告の実発動: **0回**(3回連続でゼロ。※grep で fixture 内の変数名 `fallback` を拾う誤検知に注意)
- **コンテキスト管理が初めて実戦発動**: async-race と breaking-upgrade で compact が発動(async-race: 約11.7k→5.3kトークンへ圧縮)、prune は計26回。圧縮後もタスクを完遂しており、prune/compact の実地動作を初めて確認できた
- large-codebase は理想軌跡: bun test で失敗観測 → glob → **grep(round|toFixed|floor|ceil)で36ファイルを読まずに root cause へ直行** → read → 1行 edit → bun test。コンテキスト最大15%で完了し、Sonnet 比 2.7倍の時間差に収まった
- test-triage: 3つの根本原因(共有ユーティリティのカスケード/境界値/ソート比較関数)を全て特定。部分修正で満足せず bun test を再実行して残りを潰す指示遵守を確認

### 観察された弱点(Sonnet との差)

1. **思考の空転**: async-race で「in-flight Promise は既にキャッシュされているはずでは」という自問の堂々巡りに長時間を消費(思考ログ上で同じ仮説を3回再検討)。所要 903s の大半は推論トークン。Sonnet は 101s
2. **書き換え時の退行**: breaking-upgrade でファイルを丸ごと書き直した際に既存エクスポート(makeConfigStore, endSession 等)を落とし、テストで発覚→自己修復に約20コールを追加消費。edit 優先・write 抑制のプロンプト誘導が改善候補
3. 所要時間比は従来の2〜4.7倍から **2.7〜14倍へ拡大**。複雑タスクほど推論量の差が増幅される。30分タイムアウトは複雑タスクでは限界に近い

### 結論(第3回)

高難度5タスクでも**成果物品質は 5/5 で Claude Code (Sonnet) と同等を維持**。第2回までの留意点だった「コンテキスト管理の実地検証」は今回 compact/prune の実戦発動と完遂で解消した。残る差は速度(特に長考タスク)と、丸ごと書き換え時の退行癖。次の改善候補は (a) システムプロンプトでの edit 優先誘導、(b) 思考ループの早期打ち切りヒューリスティック、(c) 複雑タスク向けタイムアウト延長。

## 第4回評価: ハーネス改善後の全14タスク再測定(2026-07-06)

第3回で観察した弱点(思考の空転・丸ごと書き換え時の退行)への対策として、**thinking watchdog**(`--think-budget`、出力開始前の思考が予算超過で中断・再試行)、**実時間予算**(`--max-time`)、**headroomベースのcontext gate**(過剰なnum_predict予約による早発compactionの是正)、**presence_penalty**、**writeガードレール**(既存30行以上ファイルの全書き換えは`overwrite:true`必須)を実装。全14タスクを両エージェントで一から再実行し、あわせて評価ランナー自体も改修し、ハーネスは`--json`、Claude Codeは`--output-format json`の構造化出力を初めて計装(turns/tool calls/tokens/コストを機械的に記録。従来は目視でログを転記していた)。環境: Claude Code 2.1.201(第1〜3回は2.1.199)、Ollama 0.30.6、`qwen36-27b-mtp:latest`。

### 結果

| タスク | ハーネス (Qwen3.6) | Claude Code (Sonnet) | 速度比 |
|---|---|---|---|
| add-feature | **PASS** 82s | **PASS** 28s | 2.9x |
| api-migration | **PASS** 190s | **PASS** 59s | 3.2x |
| async-race | **PASS** 457s | **PASS** 62s | 7.4x |
| breaking-upgrade | **PASS** 1257s | **PASS** 135s | 9.3x |
| debug-runtime | **PASS** 88s | **PASS** 41s | 2.1x |
| explore-codebase | **PASS** 59s | **PASS** 28s | 2.1x |
| fix-bug | **PASS** 107s | **PASS** 29s | 3.7x |
| follow-conventions | **PASS** 93s | **PASS** 35s | 2.7x |
| git-workflow | **PASS** 247s | **PASS** 46s | 5.4x |
| hard-multi | **PASS** 218s | **PASS** 47s | 4.6x |
| large-codebase | **PASS** 120s | **PASS** 40s | 3.0x |
| refactor | **PASS** 156s | **PASS** 32s | 4.9x |
| spec-feature | **PASS** 646s | **PASS** 77s | 8.4x |
| test-triage | **PASS** 329s | **PASS** 53s | 6.2x |
| **成功率** | **14/14 (100%)** | **14/14 (100%)** | 総所要 67.5分 vs 11.9分(平均5.7倍、範囲2.1〜9.3倍) |

### 計装データ(今回初計測)

| タスク | harness turns/tool calls | claude turns | harness tokens(最終ターン prompt / 累積 completion) | claude tokens(累積 in / out) | claude API costs |
|---|---|---|---|---|---|
| add-feature | 5 / 5 | 8 | 3,879 / 1,014 | 90,783 / 868 | $0.096 |
| api-migration | 9 / 17 | 19 | 5,983 / 1,765 | 235,782 / 3,349 | $0.203 |
| async-race | 11 / 12 | 9 | 9,072 / 3,895 | 143,107 / 3,039 | $0.166 |
| breaking-upgrade | 22 / 32 | 24 | 15,157 / 10,262 | 230,624 / 8,484 | $0.304 |
| debug-runtime | 5 / 5 | 10 | 3,739 / 835 | 119,688 / 1,419 | $0.116 |
| explore-codebase | 4 / 6 | 8 | 3,106 / 499 | 70,750 / 1,012 | $0.081 |
| fix-bug | 6 / 7 | 8 | 4,240 / 994 | 102,381 / 1,130 | $0.105 |
| follow-conventions | 5 / 6 | 9 | 3,668 / 879 | 105,811 / 998 | $0.104 |
| git-workflow | 16 / 17 | 10 | 6,191 / 2,452 | 136,231 / 1,356 | $0.120 |
| hard-multi | 11 / 15 | 11 | 6,535 / 2,019 | 115,522 / 2,045 | $0.133 |
| large-codebase | 7 / 6 | 9 | 5,073 / 1,081 | 140,606 / 1,554 | $0.137 |
| refactor | 9 / 10 | 9 | 4,668 / 1,664 | 87,038 / 1,283 | $0.094 |
| spec-feature | 17 / 22 | 13 | 12,462 / 6,487 | 181,796 / 3,870 | $0.196 |
| test-triage | 15 / 22 | 15 | 9,548 / 2,880 | 150,496 / 2,316 | $0.151 |
| **合計/平均** | — | — | 累積completion合計 **36,726** | 累積 in **1,910,615** / out 合計 **32,723** | 合計 **$2.01**(平均$0.14/タスク) |

**注(単位の非対称性)**: harnessの`promptTokens`は現状「最終ターンのcontext量」のスナップショットであり(`src/index.ts`の`onEvent`が上書き代入、`completionTokens`のみ全ターン累積)、Claude側の`usage`はセッション全体の累積値。したがって prompt側の数値をそのまま比較する(93,321 vs 1,910,615)のは**単位が異なり不当**——harnessのシステムプロンプトが小型(<1500トークン)・ツール7種のみなのに対し、Claude Codeは大きな組み込みシステムプロンプト+多数のツール定義をターンごとにキャッシュ再読込している影響が大きく、素朴な比較は実態を誇張する。一方 completion(出力)トークンは両者とも全ターン累積で単位が揃っており、harness 36,726 / Claude 32,723 と**ほぼ同等**(+12%)——両モデルの出力量そのものは大差ない。コスト面は単位の問題がなく明確: Claude Code baselineは14タスクで**合計$2.01**(API課金)、harnessはローカル推論のため限界費用$0(電気代のみ)。委譲によるトークン/コスト節約という本プロジェクトの狙いを裏付けるデータ。

### 品質シグナル(ログ分析)

- **thinking watchdog**: 14タスク中**1回**発動(breaking-upgrade、思考が予算6000字を超過して中断・再試行)。中断後もタスクは正常完遂(status=ok、1257s)——スパイラルには発展せず
- **writeガードレール**: 14タスク中**2タスクで各1回**発動(breaking-upgrade: `session.ts`、spec-feature: `query/parse.ts`)。いずれも次のツールコールで即座に`overwrite: true`を付けて正しく再送し、無駄なターンなしで成功——ロールバックなしの単純な自己修正として機能
- **ツールコール修復・fallback・ループ警告**: 4回連続の評価ラウンド(計56タスク実行)を通じて**実発動0回**——保険機構として作られたが実運用トリガーは依然未検証のまま
- **prune/compact**: 今回は**0回**(全タスクでピークcontext使用率47%以下、breaking-upgradeが最大)。第3回はasync-race/breaking-upgradeで発動していたが、これはfixture・タスク遂行内容依存の差であり、機構自体の後退ではない(ユニットテストは今回の変更後も全通過)
- **max-time(1500s)超過による強制打ち切り**: 0回。最も長かったbreaking-upgradeも1257s(予算の84%)で自然完了

### 第3回との比較(同一タスクの改善確認)

| タスク | 第3回 | 第4回 | 変化 |
|---|---|---|---|
| breaking-upgrade | **1800s**(30分タイムアウトでkill、要約生成中。移行自体は完了・全16テスト通過も、既存export欠落で自己修復に約20コール消費) | **1257s**(status=ok で正常完了) | writeガードレールが退行を1回の拒否で即座に検出、20コール規模の自己修復が不要に |
| async-race | 903s(同一仮説を3回再検討する思考の空転) | 457s(watchdog発動0回、空転せず) | 約2倍高速化。ただしwatchdogは発動していないため直接の因果とは言い切れず、単発計測のためモデル出力のばらつきの可能性も残る |
| spec-feature | 908s | 646s(writeガードレール1回発動、即座に修正) | |
| test-triage | 425s | 329s | |

Claude Code側の所要時間も全般に第1〜3回より短縮している(例: fix-bug 43s→29s、async-race 101s→62s)——バージョンが2.1.199→2.1.201に上がっており、harness側の改善だけでなく比較対象(baseline)側の変動も含まれる点に注意。各ラウンドとも1タスク1試行のみで再現試行(分散測定)は未実施のため、上記の改善幅は目安であり統計的な有意差ではない。

### 結論(第4回)

**成果物品質は今回も14/14でClaude Code (Sonnet)と同等を維持**。第3回で観察した2つの弱点のうち、**丸ごと書き換え時の退行はwriteガードレールにより実質解消**(タイムアウトkillから1257sの正常完了へ、自己修復コスト20コール相当が1回の即時再送に短縮)。**思考の空転**は今回のサンプルでは発生しなかったため watchdog の抑止効果を単独では確認できていない(発動0回=何も防いでいない可能性もある)——次回以降、意図的に長考を誘発するタスクで watchdog の発動と効果を直接観測する追試が必要。速度差は平均5.7倍(範囲2.1〜9.3倍)で第1回(2〜4.7倍)と第3回(2.7〜14倍)の中間に位置し、複雑タスクほど差が開く傾向は継続。新たに計測したコスト指標では、Claude Code baselineが14タスクで$2.01かかる一方harnessは限界費用ほぼ0で、出力トークン量は両者ほぼ同等——委譲によるコスト削減という当初の設計目標を裏付けた。

### 留意点(第4回時点で未解消)

- 各タスク1試行のみ。分散/再現性の統計的検証は未実施(今回の改善幅がノイズ範囲かどうか区別できない)
- ツールコール修復・fallback・ループ検出は4ラウンド通じて実発動0回——安全網としての実効性は引き続き未検証
- harnessの`promptTokens`は最終ターンのスナップショットでClaude側の累積値と単位が異なる(上記「計装データ」注釈参照)。全ターン累積に揃えるコード変更は今回のスコープ外
- 再現: `bun run eval/run.ts --agent harness` / `--agent claude`(summary は実行ごとにタスク単位でマージ書き込み)

## 第5回評価: 網羅性ギャップを突く6タスク追加(2026-07-06)

第4回までの14タスクの網羅性を再点検した。バグ修正系(単一/複数原因/実行時/並行/大規模)・機能追加・リファクタ・移行・探索QA・git・規約遵守・仕様駆動実装は既にカバーされている一方、このハーネスの本来の用途(Claude Code からの委譲先: single-file fix / boilerplate / **rename** / **small test** / **doc tweak**)に照らすと、以下6軸が未検証だった。各軸に1タスクずつ追加し、計 **20タスク** 構成にした。新fixtureは従来同様サブエージェントが作成し、(1) pristine で verify 失敗、(2) リファレンス解で成功、(3) Claude Code (Sonnet) が実解可能、の三重検証を通してから採用した。

| タスク | 未検証だった能力軸 | 検証方法 | ハーネス (Qwen3.6) | Claude Code (Sonnet) |
|---|---|---|---|---|
| write-tests | **テストを書く**(既存14タスクは全て「テスト変更禁止」で逆方向のみ) | ミューテーションテスト: 4変異のどれに差し替えても新テストが失敗すること + src非改変(sha256) | **PASS** 944s (10t/14c) | **PASS** 64s ($0.16) |
| type-repair | 型エラー修復(検証チャネルが bun test 一辺倒だった) | `bunx tsc --noEmit`(strict+noUncheckedIndexedAccess、7エラー) + any/ts-ignore/asキャスト禁止grep + 挙動非変更(bun test) | **PASS** 613s (18t/23c) | **PASS** 73s ($0.18) |
| doc-sync | ドキュメントを実装に同期(コード外成果物ゼロだった) | README の4不一致(誤フラグ名/誤デフォルト×2/記載漏れ)の修正を grep 判定 + src非改変(sha256) | **PASS** 118s (7t/8c) | **PASS** 29s ($0.08) |
| no-repro | **正直な失敗報告**(全タスクが「正解が必ず存在する」前提で、迎合バイアス未測定) | 精巧な偽バグ報告(ISSUE.md)に対し src 無変更のまま `verdict: not-reproducible` を報告できるか。src/ISSUE.md は sha256 固定 | **PASS** 195s (8t/10c) | **PASS** 82s ($0.20) |
| perf-fix | 計算量の理解を要する性能改善 | O(n²) では失敗する経過時間アサーション(予算3s、O(n²)実測37s / O(n)解13ms = 2735倍マージン) | **PASS** 132s (5t/4c) | **PASS** 34s ($0.10) |
| rename-sweep | 大規模で純粋に機械的な横断リネーム(api-migrationは3ファイル。委譲の本命=「自明だが量が多い」が未検証) | 12ファイル23呼び出し箇所の新API移行 + 旧モジュール削除 + 参照残存grep + 新API側非改変(sha256) | **PASS** 484s (28t/40c) | **PASS** 90s ($0.34) |
| **成功率** | | | **6/6 (100%)** 計41.4分 | **6/6 (100%)** 計6.2分 ($1.05) |

(t=turns, c=tool calls。ハーネスは限界費用ほぼ0)

### 品質シグナル(ハーネス側ログ分析)

- ツールコール修復・fallback・ループ検出・thinking watchdog の発動: **0回**(通算62タスクで修復系の実発動0回を継続)
- prune / compact の発動: **0回**(最長の write-tests 944s でも文脈に余裕)
- **no-repro が最重要の観測**: 偽バグ報告(偽の実行ログ・もっともらしい原因推測つき)に対し、Qwen3.6 が実際にコードを実行して再現失敗を確認し、src を一切変更せず not-reproducible と正しく報告した。委譲先として最も危険な故障モード(できていないのに ok と報告する/不要な変更をする)への耐性を初めて実測で確認
- rename-sweep(23箇所)は 40 ツールコールで漏れなく完遂 — 「1件1件は自明だが件数が多い」反復編集の安定性を確認。ただし所要484sはSonnetの5.4倍で、量に比例して速度差のコスト(壁時計時間)は増える
- write-tests は 944s と最長。20テストを書き4変異全kill。テスト設計(仕様の読み取り→境界ケース列挙)は現状ハーネスの最も時間がかかる作業種

### 設計上の発見(fixture作成時)

- **bun のテストタイムアウトは同期CPUバウンドコードをプリエンプトできない**(タイマーがイベントループに戻らないと発火しない)。perf-fix の性能ゲートはテスト内 `performance.now()` の経過時間アサーションで実装した
- ランナーのsha256保護は「相対パスに test を含む既存ファイル」のみが対象。fixture の守りたい非テスト資産(src の非改変性、ISSUE.md、tsconfig.json、新API側モジュール)は各 verify.sh に sha256 を埋め込んで保護した

### 結論(第5回)

追加6軸を含む20タスクで **ハーネス 20/20 PASS を維持**(Claude Code baseline も 20/20)。特に「テストを書く」「正直に再現不能と報告する」「大量の機械的編集を漏れなく」という委譲ユースケースの中核3軸が新たに実証された。未カバーとして残る軸: 非TS言語(fixture の bun-only 依存フリー原則とのトレードオフで見送り)、マルチターン対話(ワンショット評価の設計外)、曖昧仕様下での質問/仮定明示(自動判定困難)、意図的に長考を誘発するタスクでの watchdog 実効性検証(第4回からの持ち越し)。

## 委譲検証(2026-07-06、claude-delegate アーム)

これまでの第1〜5回は「ハーネス単体が Claude Code と同等に解けるか」を測ってきた。本ラウンドはプロジェクト本来の狙い——**Claude Code がタスクを自分で実装する代わりにローカルの `lh` CLI へ委譲すると、Claude 側の API コストは実際に下がるのか**——を直接測る。新しく `claude-delegate` アームを追加した: タスク面のプロンプトは baseline(`claude` アーム)と**バイト単位で同一**に保ち、「実装は必ず `lh` に委譲せよ」という指示は `--append-system-prompt`(`run.ts` の `DELEGATE_NUDGE`)にのみ注入する。各タスクは専用の `LH_HOME`(`eval/results/lh-home/<task>/`、実行ごとに wipe)で走らせ、Claude が実際に委譲したかをセッションファイルの有無で**機械的に**判定できるようにした。Claude 側コストは `total_cost_usd`、ローカル側は各 session の tokens/duration を回収。比較対象の baseline は同日・同バージョンの第5回 claude 実行。対象は委譲ユースケースの中核6タスク(doc-sync / no-repro / perf-fix / rename-sweep / type-repair / write-tests)。

### 結果

| タスク | 判定 base→deleg | 委譲? | Claude コスト base→deleg | 節約 | 壁時計 base→deleg | ローカル側(session tok / 時間) |
|---|---|---|---|---|---|---|
| rename-sweep | PASS→PASS | **yes** | $0.337→$0.126 | **−63%** | 90s→595s | 19,356 / 557s |
| perf-fix | PASS→PASS | **yes** | $0.104→$0.107 | +3%(±0) | 34s→123s | 6,024 / 86s |
| doc-sync | PASS→PASS | **yes** | $0.081→$0.120 | **+49%(逆に高い)** | 29s→123s | 5,229 / 79s |
| no-repro | PASS→PASS | no | $0.195→$0.166 | (−15%) | 82s→67s | — |
| type-repair | PASS→PASS | no | $0.179→$0.169 | (−6%) | 73s→68s | — |
| write-tests | PASS→PASS | no | $0.158→$0.169 | (+7%) | 64s→61s | — |
| **合計(6タスク)** | **6/6 → 6/6 PASS** | **3/6 委譲** | **$1.053 → $0.857** | **−19%** | 372s→1037s | 30,609 / 722s |

括弧付きの節約率(no-repro / type-repair / write-tests)は Claude が委譲せず自分で実装したタスクで、増減は単なる再実行ノイズ(実質 baseline と同一作業)。委譲の効果を測れたのは上位3タスクのみ。集計は両アームに存在する6タスクの交差のみ(`eval/results/delegation-comparison.md` の Totals と一致)。

### 遵守率(設計対象の故障モード)

「MUST delegate」と明示したにもかかわらず、**6タスク中3タスク(no-repro / type-repair / write-tests)で Claude Code は委譲せず自分で実装した**。Claude Code のセッション transcript(`eval/results/claude-delegate-*.log`)を確認したところ、これら3タスクでは `lh` の呼び出しが**一度もなく**、`LH_HOME` にセッションファイルも生成されていない——機構の不具合ではなく nudge の不遵守。headless(`-p`)モードでの system-prompt nudge の**遵守率そのものが故障モード**であることが判明した。委譲した3件は逆に、ローカル Qwen が status=ok で完了し feedback=pass が記録され、Claude 側の手直し(rework)はゼロ(**3/3 一発成功**)——委譲先としての品質は担保されている。

### 重要な洞察: 委譲は可変コストを「ほぼ固定のオーケストレーションコスト」に変換する

委譲した3タスクの deleg 側 Claude コストは $0.126 / $0.107 / $0.120 と、**タスク規模によらずほぼ一定(約 $0.11〜0.13)**。これは Claude Code 側に必ず残る固定オーバーヘッド——組み込みシステムプロンプトのキャッシュ + 作業指示書(work order)の作成 + 結果の検証 + feedback 記録——であり、実装作業を委譲で外に出しても消えない。つまり委譲は「タスク規模に比例する可変の実装コスト」を「規模によらないほぼ固定の ~$0.11〜0.13 オーケストレーションコスト」に置き換える。したがって節約が出るのは baseline コストがこの床を上回るタスクだけで、**損益分岐は概ね $0.13〜0.15**(=多ターンの機械的作業)。rename-sweep(baseline $0.337、33ターン/出力6,378tok)は床を大きく上回るので −63%、逆に doc-sync(baseline $0.081、6ターン)は床未満なので委譲するとかえって +49% 高くつく。壁時計時間は委譲した3タスクで **約3.6〜6.6倍**(rename-sweep 90s→595s)——ローカル推論時間がオーケストレーションに上乗せされる分。

### 留意点

- 各セル n=1(単発計測、分散なし)。節約率は方向性の目安であり統計的有意差ではない
- forced-delegation アームは不完全: 6タスク中3タスクが不遵守で、委譲の効果を実測できたのは実質3タスク
- 表の Claude コストが主指標。prompt-token はキャッシュ read/creation を含む会計でコストと非比例のため本節では割愛(詳細は `delegation-comparison.md` の caveats)
- ローカル側の compute はローカル推論のため Anthropic 課金外だが、壁時計時間・ハードウェアという別コストは残る(委譲の狙いは課金の外出しであってゼロコスト化ではない)

### 含意

delegate-local スキルの `SKILL.md`「いつ委譲するか」の基準に**コスト床**を明記すべき: 委譲は「>$0.15 相当/多ターンの機械的作業(大規模リネーム・大量ボイラープレート等)」に見えるタスクに限定し、数ターンで終わる小さな doc/型修正はむしろ委譲すると割高になる、と示す。加えて headless モードで nudge が守られないこと自体が故障モードなので、委譲判断をスキルの自然言語指示だけに委ねず、設計側(タスク分類・ゲート・明示的な委譲コマンド化)で担保する必要がある。

### nudge強化後の再測定(強制委譲アームの完成)

初回ラウンドで委譲されなかった3タスク(no-repro / type-repair / write-tests)について、`DELEGATE_NUDGE` を強化して再測定した。強化点は (a)「本ランは委譲の計測であり、実装だけでなく調査・triage も含め全作業を `lh` に回せ。自分でやると計測が無効になる」という委譲第一の明示、(b)「最初の `lh` 呼び出しが返る前にどのファイルも編集してはならない(許されるのは作業指示書を書くための軽い read のみ)」という編集禁止の明文化。結果、**3/3 が委譲**され(ソフト版の 3/6=50% から遵守率 100% へ)、6タスク全てが委譲された強制委譲アームが揃った。

| タスク(再測定) | 判定 base→deleg | Claude コスト base→deleg | 節約 | 壁時計 base→deleg | lh セッション |
|---|---|---|---|---|---|
| type-repair | PASS→PASS | $0.179→$0.152 | −15% | 73s→158s | 10 turns / 102s |
| write-tests | PASS→PASS | $0.158→$0.154 | −3% | 64s→160s | 4 turns / 93s |
| no-repro | PASS→**FAIL** | $0.195→$0.154 | (−21%) | 82s→210s | 8 turns / 149s |

**no-repro の失敗機構(本ラウンド最重要の発見)**: ローカル Qwen は「再現不能」という判断自体は正しく下し TRIAGE.md も作成したが、要求された厳密な1行目フォーマット(完全一致で `verdict: not-reproducible`)を守らず先頭にマークダウン見出しを置いた。verify の出力そのもの:

> FAIL: TRIAGE.md first line must be exactly 'verdict: not-reproducible' (got: '# Triage: parseRange descending range bug')

そして Claude はこれを**意味内容だけで検証**して受理し `lh feedback pass` を記録した——つまり **委譲の真の品質リスクは「検証者(Claude)の検証が受け入れゲートより浅い」こと**にある。Claude の安価な検証(diff を読む/意味を確認する)が、タスクの厳密な合格条件(1行目の完全一致)をすり抜けた。初回ラウンドで Claude が同じタスクを自分でやったときは PASS だったので、これは委譲によって新たに混入した故障モードである。

強制委譲アーム(6/6 委譲)の集計 ※ doc-sync / perf-fix / rename-sweep はソフト版でも委譲された初回ラウンドの値を流用しており、アーム内で nudge バージョンが混在する:

| metric | baseline (claude) | claude-delegate(強制) |
|---|---|---|
| passed | 6/6 | **5/6** |
| Claude コスト | $1.053 | **$0.813(−23%)** |
| Claude 壁時計 | 372s | 1369s(**3.7倍**) |
| ローカル側 compute | — | 50,276 tok / 1067s |

委譲時の Claude コストは6タスク全てで **$0.107〜$0.154** に収まり、タスク規模(baseline $0.081〜$0.337)に関わらずほぼ一定——固定オーケストレーションコスト(floor)を強制アームでも再確認できた。

**結論(委譲検証・両ラウンド総括)**: 強制委譲(hardened nudge)は Claude コストを **−23%** 下げるが、**品質退行(6→5/6 PASS)と実時間 3.7倍**を伴う。一方、自然遵守に任せた初回ラウンドは **−19%・6/6 PASS** で、Claude が委譲を見送った3タスクはいずれも損益分岐($0.13〜0.15)近傍の小タスクだった——**Claude の「これは自分でやる」という判断は損益分岐点近傍ではほぼ経済的に合理的**だったことになる。この総括の含意は本セッションで反映済み: (1) `SKILL.md`(原本+インストール版)にコスト床と「`feedback pass` の前に受け入れコマンドそのものを再実行する」厳密検証ルールを追加、(2) ルート `README.md` に「委譲は得か」節と CLAUDE.md/AGENTS.md 設定 Tips を追加、(3) `integrations/codex/AGENTS-snippet.md` を同方針に更新。全セル n=1 の単発計測である点は留意。

### Haikuワーカー対照実験(委譲先の切り分け)

上の結果は「委譲は固定オーケストレーション費を生む」と示したが、その床が**ローカルLLM(Qwen)固有の欠点**なのか**委譲という構造そのものの費用**なのかは切り分けられていなかった。これを判定するため、委譲構造を完全に同一に保ったまま**委譲先だけを差し替えた**対照アーム `claude-delegate-haiku` を実施した。オーケストレータは同じ Sonnet(`spec.prompt` はバイト同一、指示は `HAIKU_DELEGATE_NUDGE` を `--append-system-prompt` で注入)で、ワーカーだけを無料のローカル `lh` から**課金される `claude -p --model haiku`** に置換する。ワーカーは結果を `<workdir>/.delegate/worker-N.json` に書き、ランナーが workdir 削除前に退避して `total_cost_usd`/`is_error` を回収。委譲発生は worker JSON の有無で機械判定し、隔離した LH_HOME(空のままが正常=lh 混入ガード)と `~/.claude/projects` の session 数で二重に検証した。強制版と同じ6タスクで実施。

**結果: 6/6 PASS、6/6 委譲、lh 混入 0 件・ワーカー is_error 0 件。**

| タスク | 判定 | orch 費 | worker 費 | 課金合計 | 壁時計 |
|---|---|---|---|---|---|
| doc-sync | PASS | $0.118 | $0.036 | $0.154 | 65s |
| no-repro | PASS | $0.164 | $0.048 | $0.213 | 104s |
| perf-fix | PASS | $0.128 | $0.040 | $0.168 | 68s |
| rename-sweep | PASS | $0.140 | $0.094 | $0.235 | 111s |
| type-repair | PASS | $0.172 | $0.047 | $0.220 | 115s |
| write-tests | PASS | $0.184 | $0.053 | $0.238 | 106s |
| **合計(6)** | **6/6** | **$0.907** | **$0.318** | **$1.225** | **569s** |

**H1(固定床の委譲先非依存性)= 確認**。lh アームのコスト($0.813、ワーカー無料なので全額がオーケストレーション)と haiku アームの**オーケストレータのみ**コスト($0.907)は +12% の差に収まり(単発計測のばらつき範囲)、doc-sync では $0.120 vs $0.118 とほぼ一致した。→ **委譲の固定床は呼び出し元(Sonnet オーケストレータ)側の構造費であって、LocalRig の欠陥ではない。** どのワーカーに投げても同じ床がかかる。

**H2(ワーカー品質)= ギャップは実在するが小さい**。合格率は haiku 6/6 vs Qwen(lh)5/6。唯一の差は no-repro で、haiku は厳密な1行目フォーマット(`verdict: not-reproducible`)を守って PASS、Qwen は見出しを先頭に置いて FAIL。ローカルモデルの品質ギャップは「厳密フォーマット遵守1件」——まさに fix_plan.md の P0-1(`--check` 自己検証)が塞ぐ故障クラスである。

**H3(実時間)= 3.7倍のうち構造分は ~1.5倍**。壁時計は baseline 372s / haiku 569s / lh 1369s。lh アームの 3.7倍ペナルティのうち、委譲構造そのもの(高速ワーカーでも残る分)は ~1.5倍で、残りはローカル推論の遅さ(ハードウェア依存であってハーネスの問題ではない)。

**経済的な核心**: **安価な API ワーカーへの委譲は純損**である——haiku アームの課金合計 $1.225 は baseline $1.053 より **+16%** 高い。床($0.907)にワーカー費($0.318)が上乗せされるため。**委譲でコストが下がるのは「ワーカーの限界費用がほぼゼロ(=ローカル)」かつ「タスクが床を超える」ときだけ**、という条件が対照実験で確定した。

#### 落とし穴: バックグラウンド起動されたネスト claude の静かな失敗(パイロット2回焼失)

クリーンな計測に至る前に2回のランを焼失した。いずれも 40 分の SIGKILL で終わり、症状は同一だった:

- **1回目**: `worker-1.json` が 0 バイト、stderr が `api.anthropic.com` の ENOTFOUND / timeout で埋まっていた(一見ネットワーク障害)。
- **2回目**: ネットワークエラー無しで同じ症状。オーケストレータのトランスクリプトを精査すると、ネストした `claude` ワーカーを Claude Code の**バックグラウンド Bash 実行**で起動しており、この環境ではバックグラウンドのネスト claude が**静かに起動失敗**していた(task は "running" のままだが `ps` にプロセスが存在しない)。オーケストレータは TaskOutput を約31分ポーリングし続けたのち、フォアグラウンドの `claude -p "Say hello"` プローブで自己診断(2秒で成功)、フォアグラウンドで再実行したが完了直前に SIGKILL された。1回目のネットワーク嵐も同じ罠(バックグラウンド化された子プロセス)であって実際の障害ではなかった。
- **修正**: `HAIKU_DELEGATE_NUDGE` を、ワーカーを **`< /dev/null` + Bash タイムアウト 600000ms でフォアグラウンド実行**するよう明示し、「バックグラウンドのネスト claude はこの環境で静かに起動失敗する」と注記した。3回目のランはクリーンに完走した。
- **正直な注記**: 焼失した2回のオーケストレータコストは回収できていない(SIGKILL されたランは result JSON を出さないため)。上表・集計は3回目のクリーンなランのみを反映する。

### 第3ラウンド: --check自己検証つき再評価(fix_plan P0実装後)

第2ラウンドで露呈した故障モード(厳密フォーマットゲート + 呼び出し元の浅い検証 → 偽 pass)を構造的に潰すため、ユーザーが fix_plan.md の P0/P1 を手動実装した:

- **P0-1 `--check`**: エージェントループ完了後に受け入れコマンドを lh 自身が cwd で実行し、失敗ならローカルモデル(限界費用ゼロ)で最大 `--check-retries` 回修復してから返す。`check.exit_code`/`attempts`/`output_tail` を `--json` と SessionRecord に記録。
- **P0-2 report**: `--json` に `report.changed_files`(write/edit 経由の変更)と `report.commands_run` を追加(bash 経由の変更は非追跡と明記)。
- **P1-1 `--kind` + `stats --by-kind`**: 委譲を種類タグ付けし、種類別の合格率・平均時間を集計可能に。
- **P1-2 submit/wait/poll**: detached 実行で呼び出し元の待ち時間ブロックを解消。

(実装は `src/check.ts` ほか、ユニットテスト 220 件通過。)これに合わせて `DELEGATE_NUDGE` を更新: 作業指示を stdin heredoc(`lh -p - <<'EOF'`)で渡し、`--check "<受け入れコマンド>"` と `--kind <tag>` を必須化、`check.exit_code===0` なら再検証は diff 一読で済ませる、と明示(ワーカーのフォアグラウンド実行の1行も追加)。第2ラウンドの成果は `eval/results/*.round2.*` に退避してから再実行した。

**結果(第3ラウンド)**: 6/6 PASS、6/6 委譲、`--check` を全6タスクで使用(全 exit 0・attempts 1)、`--kind` を全6タスクで付与。

| タスク | 判定 R2→R3 | orch 費 R2→R3 | --check | --kind |
|---|---|---|---|---|
| doc-sync | PASS→PASS | $0.1202→$0.1105 | exit 0 (1) | docs |
| no-repro | **FAIL→PASS** | $0.1541→$0.1469 | exit 0 (1) | bugfix |
| perf-fix | PASS→PASS | $0.1067→$0.1084 | exit 0 (1) | perf |
| rename-sweep | PASS→PASS | $0.1261→$0.1100 | exit 0 (1) | rename |
| type-repair | PASS→PASS | $0.1517→$0.1780 | exit 0 (1) | types |
| write-tests | PASS→PASS | $0.1536→$0.1627 | exit 0 (1) | tests |
| **合計(6)** | **5/6→6/6** | **$0.8125→$0.8165** | 6/6 exit 0 | — |

**fix_plan P0-1 の合格条件に対する評価**: (a) no-repro が PASS に回復 = **✅**、(b) オーケストレーターコスト低下 = **✗(横ばい: $0.8125→$0.8165、+0.5%)**、(c) 6/6 PASS 維持 = **✅**。(b) が外れたのは fix_plan 自身の予測どおり——**floor は呼び出し元側の固定費なので `--check` では動かない。得られたのはコストではなく品質**である(Haiku 対照実験の H1 とも整合)。

**機構の注記(なぜ偽 pass が消えたか)**: 全6タスクで check は **attempts 1・exit 0**、すなわち**修復ループは一度も発火していない**。それでも no-repro が回復したのは、受け入れゲートが「作業指示に埋め込まれた `--check` コマンド + ローカル側での機械検証」へ移ったため——ローカルモデルが自分の成果物を厳密ゲートに対して検証してから返し、Claude は `check.exit_code` を見るだけでよくなった。第2ラウンドの「Claude が意味内容だけ見て偽 pass を記録する」経路が**構造的に消滅**した(修復が効いたのではなく、検証の位置が正しくなった)。

**壁時計**: 1369s→1525s(+11%、check 実行のローカル時間が上乗せ)。

**総括**: baseline $1.0530/372s → 第3ラウンド **$0.8165/1525s = −22% コスト・6/6 PASS・6/6 委譲**。一連の委譲検証で**初めて品質退行ゼロのラウンド**を達成した。確立された運用形は「大きく機械的で受け入れコマンドで厳密検証できるタスクを、stdin heredoc の作業指示 + `--check` + `--kind` で委譲する」——コストは floor(≈$0.13〜0.15/タスク)で頭打ちだが、`--check` が品質退行を塞ぐ。

### 第4ラウンド: 重量級タスクと非同期モードの実測、残課題の決着(2026-07-06)

第3ラウンドで「floor は呼び出し元の固定費」「`--check` が品質を担保する」ことが確定した。本ラウンドは fix_plan.md に残った4課題を実測で決着させる。全セル n=1(単発計測)。

#### 課題4: 重量級タスク mass-migration での節約幅(外挿仮説の反証)

これまでの eval スイートは最大でも baseline $0.34(rename-sweep, 12ファイル)と小粒で、「委譲が最も効くはずの領域(baseline $1 超)」が未測定だった。fix_plan.md の外挿モデル(floor 固定・節約は baseline に比例 → $1 超の重量級で −80% 級)を検証するため、40ファイル・46呼び出し箇所の機械的 API 移行 fixture `mass-migration` を追加した。

- **fixture 設計**: 旧 `log.write(level, msg)` → 新 `logger.emit({level, msg, source})`。第3引数 `source`(発信元モジュール名)の正解値は各ファイル先頭の `// module-source:` コメントにのみ存在し、**パスからは機械的に導出できない**(単一 sed では解けない設計)。三重検証済み(pristine で verify FAIL / リファレンス解で PASS / Sonnet 実解可能=今回の baseline)。

| アーム | 判定 | Claude コスト | 壁時計 | orch turns | ローカル側 |
|---|---|---|---|---|---|
| baseline(Sonnet 単独) | PASS | $0.2305 | 88s | 11 | — |
| claude-delegate(--check) | PASS | **$0.1293(−44%)** | 599s(**6.8倍**) | 7 | 18t/23c・555s・check exit 0(attempts 1)・feedback pass |

- **中心的発見(外挿の反証)**: 「baseline $1 超で −80% 級」という予測は**不成立**。baseline はファイル数に線形でスケールしない——rename-sweep(12ファイル)$0.337 → mass-migration(40ファイル)$0.2305 と**むしろ低下**した。理由はトランスクリプトに明白で、**Sonnet は各ファイルの `// module-source:` コメントを Python スクリプトで機械抽出し、46箇所を一括書き換え**した(grep×3 → python3 ヒアドキュメント → rm → verify)。機械的で規則を記述できるタスクは、Sonnet がスクリプトに畳んで償却してしまう。すなわち **「ローカル27Bに委譲できるほど機械的なタスクは、Sonnet がスクリプト化できるほど機械的でもある」** という構造的天井が存在する。委譲の現実的な節約上限は「floor($0.11〜0.15) vs baseline $0.2〜0.4」= **−30〜50%帯**であり、この種の機械的タスクでは $1 超の baseline がそもそも生じにくい。なお floor 不変性は40ファイル規模でも再確認できた($0.1293 は floor 帯の中)。
- **補足**: 委譲先のローカル Qwen もスクリプト的に解いた(bash 6回=ループ/sed を含む処理 + read 9回 + todo 6回)。両モデルとも機械的スイープはスクリプトへ収束する。

#### 課題1: submit/wait 非同期モードの効果(負の結果)

第3ラウンドは同期実行で、submit/wait による呼び出し元のブロック時間短縮効果が未測定だった。`claude-delegate-async` アーム(`ASYNC_DELEGATE_NUDGE`: submit → 検証準備 → wait のパターン。委譲第一/フォアグラウンド/`--check`/`lh feedback` の契約は同期版と同一)を追加し、rename-sweep で1回実測した。

| アーム | 判定 | Claude コスト | 壁時計 | orch turns | ローカル側 |
|---|---|---|---|---|---|
| 同期(第3ラウンド) | PASS | $0.1100 | 521s | 6 | — |
| 非同期(submit/wait) | PASS | $0.1466(**+33%**) | 539s | 11 | 12t/32c・495s・check exit 0・feedback pass |

- **決定的証跡(トランスクリプトのタイムライン)**: 検証準備の read は **submit 前**(12:35:05〜14)に完了 → 12:35:29 に `lh submit` → その **3秒後**の 12:35:32 に `lh wait` を開始 → 12:43:49 まで約497秒ブロックした。submit と wait の間に実作業は挟まっていない。
- **結論(負の結果)**: 単一タスクの headless(`-p`)設定では**実効ブロック時間は短縮されない**。作業指示書を書くための検証準備 read はどのみち submit 前に必要で、submit 時点で「待ち時間中にやる仕事」が残っていないからだ。コストは submit/wait のターン増(6→11)で **+33%**。合格条件(PASS 維持のうえでブロック時間短縮)は**不成立**。submit/wait の価値は単一タスクのレイテンシではなく「対話セッションで複数の作業を並行に抱える」ユースケースにあり、本 eval のワンショット設計では測定不能——という限定を明記する。

#### 課題2 / 課題3: --resume 実装と --worktree 見送り

- **課題2 `lh --resume <session_id>`(実装完了・eval 対象外)**: check 失敗や部分的な差し戻し時に、フル作業指示を再説明せず同一コンテキストへ追撃指示を送れる one-shot 専用フラグを実装した(元セッションの transcript 復元 + 新 session_id・`resumed_from` の記録、`--cwd` 未指定時は元セッションの cwd 継承、不明 ID は `error_kind:config`、REPL/`submit` では明確に拒否)。bun test 229件パス・実機スモーク済み(ファイル名を再説明しない追撃指示が文脈から解決された)。差し戻しコスト削減が狙いだが、第3ラウンド以降 check 失敗の実例が出ていないため**効果の実測は今後**(check 失敗の実例が出た時)。
- **課題3 `--worktree` パッチモード(見送り確定)**: fix_plan の判断基準どおり見送る。課題1・2・4 の実測を通じて並行編集の事故は観測されず、`--check` 導入により当初の動機(偽 pass による作業ツリー汚染)は構造的に解消済みのため。

#### nudge/タイムアウトの変更(コスト比較可能性の維持)

本ラウンドでは重量級タスクのローカル実行が20分を超える可能性に備え、`DELEGATE_NUDGE` の**数値のみ**を変更した(`--max-time` 1200→1800、Bash タイムアウト 1500000→2100000ms、委譲アームの SIGKILL バックストップ 40分→55分・環境変数 `DELEGATE_TASK_TIMEOUT_MS` で上書き可)。行動指示の文言は第3ラウンドと同一なので、アーム間のコスト比較可能性は維持される。

#### 総括(第4ラウンド)

4課題を実測で決着した。**課題4が最重要の負の発見**——「重量級ほど委譲が効く」という素朴な外挿は、Sonnet が機械的タスクをスクリプトに畳んで償却するため成立しない。委譲の節約は **−30〜50%帯が現実的上限**で、floor 不変性は40ファイル規模でも保たれた。**課題1も負の結果**——単一タスクの headless では submit/wait はブロック時間を縮めず、むしろ +33%(価値は対話セッションでの並行作業にあり本設計では測定不能)。**課題2(`--resume`)は実装完了**したが効果の実測は check 失敗の実例待ち。**課題3(`--worktree`)は見送り確定**。以上で fix_plan.md の全課題を完了とする。

### 第5ラウンド: バッチ委譲による floor 償却と非同期の使い所の決着(2026-07-06)

第4ラウンドで残った2つの構造的疑問——(1) 固定 floor の大半はセッション起動費なら、**1セッションで N 件委譲すれば起動費が償却され軽タスクも黒字化するのでは**(fix_plan 課題1)、(2) 単一タスクで純損だった submit/wait は、**本来の使い所(委譲向き A を投げて委譲不適 B を進める)なら壁時計を縮められるのか**(課題3)——を実測で決着させる。加えて learning loop を閉じる課題2(stats を委譲判断に接続)の実装を完了した。fixture を2件(`batch-trio`・`async-pair`)追加し、`run.ts` に新アーム3種(`claude-delegate` を batch-trio に流用 + 非同期の同期/非同期ペア)を足した(+45行・削除0=既存 nudge は無改変)。全セル n=1(単発計測)。

#### 課題1: バッチ委譲 — 1セッションに独立3タスクを同居させ起動費を償却

独立な軽〜中タスク3件(doc-sync 級=docs / type-repair 級=types / perf-fix 級=perf)を1リポジトリに同居させた複合 fixture `batch-trio` を追加し、`claude-delegate` アーム(既存 nudge のまま)で1回実行。Claude は同一セッション内で3件を順に `lh` 委譲した。比較対象は (a) 同じ複合タスクを Sonnet 単独で解いた baseline、(b) 3タスクを別々のセッションで単発委譲した合計(第3ラウンド --check 値を流用)。

| アーム | 判定 | Claude コスト | 1件あたり | 壁時計 | orch turns | ローカル側 |
|---|---|---|---|---|---|---|
| baseline(Sonnet 単独) | PASS(3/3) | $0.3510 | $0.1170 | 156s | 24 | — |
| 単発委譲3件合計(doc-sync + type-repair + perf-fix、--check) | 3/3 PASS | $0.3969 | $0.1323 | 568s | 27 | 424s(別々の3セッション) |
| **バッチ委譲(batch-trio、1セッション)** | **3/3 PASS** | **$0.1921** | **$0.0640** | 536s | 15 | 480s(逐次) |

バッチ内の3委譲はいずれも session JSON に `--kind` が正しく記録され(docs / types / perf)、`--check` は3件とも exit 0(attempts 1)、`lh feedback` は3件とも pass、Claude 側の手直しゼロ。セッションの createdAt を見ると3件は完全に逐次で走っており(各セッションが前の終了から 0.1s 未満で開始、並列ではない)、ローカル合計は 480s(94s + 249s + 137s)。

- **中心的発見(課題1=合格)**: バッチの1件あたり実効費 **$0.064 は単発 floor($0.132/件)比 −51.6%**——合格条件(−30% 以上)を大きく超える。baseline 比でも −45.3%、単発3件合計比でも −51.6%。壁時計もバッチ 536s は単発3件合計 568s より速い(セッション起動が1回で済むため)。
- **起動費の分解**: 単発=起動費 S + 作業費 T、バッチ=S + 3T とおくと、3×(S+T)=$0.3969 と S+3T=$0.1921 から **S ≈ $0.102(1セッションの起動費)、T ≈ $0.030(1件あたりの作業指示+検証+feedback 費)**。第2〜4ラウンドで観測した「floor ≈ $0.11〜0.15」は実は **S+T** であり、その大半 S はセッション単位・委譲件数に非依存だったことが数値で裏取りできた。バッチ化するとこの S が N 件で割られ、1件あたりは N→大で限界費 T($0.03)へ漸近する。
- **損益分岐の2段書き(README/SKILL 反映用)**: **単発委譲 ≈ $0.11〜0.18/件(=S+T、フルセッション)** に対し、**1セッションで N≥3 件バッチ委譲すれば1件あたり ≈ $0.06〜0.08(実測 $0.064)**。単発では負ける軽タスク(doc-sync は単発で baseline 比 +49% の負け)も、他の委譲と束ねれば起動費を分担して黒字化しうる。fix_plan の予測「バッチ時 $0.06〜0.08/件」は実測で的中した。
- **注記**: ローカル合計 480s は SIGKILL バックストップ(既定55分)に対し十分余裕。バッチが長くなってもタイムアウトは問題にならない規模。

#### 課題3: マルチタスク非同期 — submit/wait の存在意義の決着

第4ラウンドの負の結果(単一タスクで +33%)は「待ち時間中にやる仕事がない」ことが原因だった。本ラウンドは本来の使い所を測る: 委譲向き A(money.ts→pricing.ts の10ファイル移行、ローカル ~5分)と、Claude が自分で書くべき委譲不適な軽作業 B(NOTES-ARCH.md 作成)を同居させた `async-pair` fixture で、同期版(A を `lh -p` で待ち切ってから B)と非同期版(`lh submit` で A を投げ → B を自分で実施 → `lh wait` → 検証)を各1回比較した。

| アーム | 判定 | Claude コスト | 壁時計(durationSec / CLI) | orch turns | ローカルA | A終了後の残作業 |
|---|---|---|---|---|---|---|
| baseline(Sonnet 単独) | PASS | $0.2755 | 96s | 29 | — | — |
| 同期(A ブロック → B) | PASS | $0.2803 | 384s / 378s | 22 | 289s | ~40s(B + 検証 + feedback) |
| **非同期(submit A → B → wait)** | PASS | **$0.2468(−12%)** | 424s / 391s | 21 | 320s | ~16s(検証 + feedback のみ) |

- **決定的証跡(タイムライン)**: セッション JSON の createdAt と feedback.jsonl の createdAt で順序を再構成した。同期は A(k0e7)開始 13:59:58 → 289s 後 ~14:04:47 に終了 → feedback 14:05:27(A 終了の **+40s**)。非同期は A(l2kx)開始 14:07:21 → 320s 後 ~14:12:41 に終了 → feedback 14:12:57(A 終了の **+16s**)。**A 終了後のクリティカルパスが同期 40s(B+検証+feedback)→ 非同期 16s(検証+feedback のみ)に縮んでいる**——差 ≈24s は、B の作成が A のバックグラウンド実行中に片付き、A 終了後の経路から外れた分。**overlap の機構そのものは確かに働いた。**
- **にもかかわらず net 壁時計は縮まない(課題3=不成立)**: 非同期 424s > 同期 384s(durationSec)、391s > 378s(CLI)。A のローカル実行が 320s vs 289s = **+31s(ローカル推論の分散 +10.7%)** で、~24s の B 重畳節約を上回った。壁時計 − ローカルA(非ローカル時間)で正規化しても符号が測定法で割れる: durationSec では同期 95s / 非同期 104s、CLI duration_ms では同期 89s / 非同期 71s。B 節約(~18〜24s)は測定ノイズ+ローカル分散(±31s)と同オーダーで、n=1 では net 効果は実質ゼロ〜わずかに負。
- **理論短縮上限 = min(A, B) = B ≈ 24s**(A 終了後クリティカルパスの差=B が A の裏に隠れた時間)。総時間 ~390s の約6%にすぎず、ローカル推論の分散だけで 31s(8%)ある。**設計前提が「大きい A を委譲し小さい B を自分で持つ」である以上 B≪A が保証され、オーケストレータは B を早々に終えて残りの A を `lh wait` でブロックする——同期のブロックと変わらない。** 壁時計短縮が出るのは B≈A のときだけで、これは設計前提と矛盾する。
- **コスト −12% の機構(latency ではなく副作用)**: 非同期は cacheCreation 26,925 vs 同期 39,239 と高価なキャッシュ生成を 12,314 トークン少なく済ませた(≈ −$0.046)。B を A の裏で一続きに処理したためコンテキストを1回だけ構築でき(cacheRead 再利用が増え re-creation が減る)、同期の「長時間ブロック → 再開して B」という分断がキャッシュ再生成を増やしていた。turns はほぼ同じ(21 vs 22)。壁時計短縮でなくトークン会計の副産物。
- **結論**: headless(`-p`)エージェント用途では submit/wait は**推奨しない**とログ根拠で断定できる。第4ラウンドの「単一タスクで純損」に続き、本ラウンドで「本来の使い所(A‖B)でも net 短縮なし」を確認した。価値が残るとすれば、人間が A の実行中に同規模の作業を継ぎ足せる**対話セッション**のみ——ワンショット/headless 委譲フローからは外すのが妥当。

#### 課題2: stats を委譲判断に接続(実装完了・実測は宿題)

feedback は write-only だった learning loop を閉じた。`lh stats --by-kind --json` の各 kind に pass `rate` を追加(graded=0 は null、テキスト出力は `?? 0` フォールバック)し、`SKILL.md`(原本)の「When to delegate」冒頭に事前チェックを追加——委譲前に stats を読み、当該 kind が `graded >= 3` かつ `rate < 50`(fail が過半)なら委譲せず自力実行 or 作業指示を具体化してから再挑戦(graded<3 は signal が薄いので下の基準にフォールバック)。`integrations/codex/AGENTS-snippet.md` の Rule 2 にも同基準を反映。ユニットテスト 231 件通過、隔離 LH_HOME に pass/fail feedback を仕込んだスモークで判断分岐を確認済み。**効果の定量測定は feedback データ蓄積後の宿題**(現状は fail 過半の kind が実データ上まだ存在しないため)。インストール版 SKILL.md への事前チェック文の同期は doc-sync 対象として残る。

#### 総括(第5ラウンド)

**課題1=合格・課題3=不成立**で、委譲の経済モデルが2点で精緻化された。(1) floor の大半(≈$0.10)はセッション起動費で件数非依存——**1セッションに複数委譲を束ねれば1件あたり実効費は $0.064(単発比 −51.6%)まで下がり**、単発では負ける軽タスクもバッチ内なら黒字化する。損益分岐は「単発 $0.11〜0.18/件・バッチ時 $0.06〜0.08/件」の2段書きに更新すべき。(2) submit/wait は overlap 機構自体は動く(B を A の裏に隠せる)が、設計前提から B≪A が不可避で、委譲した大タスクの残り時間を結局ブロックするため **headless では net 壁時計短縮なし**——第4ラウンドの単一タスク純損に続き「使わない機能」と断定できる(価値は対話セッションの並行作業のみ)。課題2(stats 接続)は実装完了、効果測定はデータ待ち。いずれも n=1 の単発計測である点は留意。

**(第6ラウンドからの注記)** 本ラウンドまでのドル金額は Claude Code CLI **2.1.77 の会計**(システムプレフィックス ~10.9k tok、キャッシュ書き実効 $3.75/M)での値。2.1.202 でプレフィックスが ~35.6k tok・書き単価が $6/M に変わり、絶対額はラウンド間で直接比較できなくなった(相対構造 S+T やバッチ償却の論理は保持される)。詳細は第6ラウンド参照。

### 第6ラウンド: `lh batch` 一級化の実測 — CLIバージョン交絡と間欠ネットワーク断という二重の環境戦(2026-07-07)

第5ラウンドで実証したバッチ償却(プロンプト手組みで 1件 −51.6%)を、一級サブコマンド `lh batch` に昇格させて実測した。実装はコミット 93ee3de(JSON マニフェスト `--tasks <file|->`、タスク毎の check+修復ループ、部分失敗セマンティクス、`feedback --task` ファンアウト、全タスク完了後の**再検証スイープ**=兄弟タスクの bash 副作用による巻き戻しを検出)と 16e9c04(初回 eval の35分ハングを診断して3欠陥を修正: `--max-time` のバッチ**総予算**化 / タスク毎の Agent 文脈フルリセット+system prompt 再利用 / セッション逐次永続化)。eval には `claude-delegate-batchcli` アーム(`BATCHCLI_NUDGE`: 独立サブタスクを**1回の** `lh batch` 呼び出しに束ねさせる)を追加し、途中で nudge を締め直した(委譲前の read を2ファイル以内に制限・チケット10行以内・ファイル内容の貼付とフィックスコードの記述を禁止)。

#### 環境戦1: ネスト claude の間欠 ConnectionRefused(未解決・回避運用で決着)

測定は環境問題に5回連続で阻まれた。sandbox 内で走らせた attempt 1〜5(05:49〜10:38 JST)は、**ローカル側は毎回完璧**(バッチ 3/3 ok・check 全通過)なのに、オーケストレータ(ネスト claude)が「長い `lh` Bash 呼び出しが返った直後の初回 API コール」で `API Error: Unable to connect to API (ConnectionRefused)` により全滅した(内部リトライ ~3分ののち断念)。切り分けの結果:

- **外部到達性は常に正常**: 並走プローブ(10秒毎 curl)は障害時間帯を含む415サンプル全てで HTTP 401(=TCP 到達 OK)。遮断は**プロセス局所**。
- **sandbox / cmux シム / アイドル長は無関係**: 午後の再測定(全て sandbox 無効・cmux PATH/NODE_OPTIONS 除去)でも 4 run 中 3 run が死亡。Python による「13分アイドル→新規 TLS 接続」プローブは sandbox 内外とも成功。2分の短い `lh` 呼び出し直後にも発生。
- **パターン**: 死亡は全て「`lh` を呼んだ Bash の完了直後の初回 API コール」で発生し、`lh` を呼ばない baseline run は無事。ただし同条件で生存した run もあり(attempt 6)、決定論ではない。根本原因は未特定(EDR=Falcon が有力容疑)。
- **実務対策**: (1) 死んでもバッチ成果はローカルに逐次永続化済みで check も通過済み——失われるのは検証・feedback ターンだけで、`--json` の `feedback_command`(`--task` プレースホルダ付き)で事後記録できる。欠陥修正で入れた逐次保存が、意図せず最大の保険として機能した。(2) 測定は「アーカイブ(`*.roundN-attemptM.*` / `*.roundN-envfail.*`)→再実行」で回す。(3) `claude -p` の結果 JSON は `is_error:true` でも作業自体は完了していることがある——PASS/FAIL はローカル成果物と verify で判定する。

#### 環境戦2: Claude Code 2.1.77→2.1.202 の会計変更(ラウンド間ドル比較の無効化)

attempt 6 の $0.526 が第5ラウンドの手組みバッチ $0.192 と乖離した原因を transcript の生 usage で追うと、**測定対象でなく物差しが変わっていた**: (1) システムプレフィックスが 10,927→35,592 tok(cold のターン1書き込み実測)に肥大=全ターンの文脈税が倍増、(2) キャッシュ書きの実効単価が $3.75→$6/M(1h ephemeral、報告 usage と `total_cost_usd` からの逆算で確定)、(3) cold/warm でターン1コストが ~$0.14 変動(共有プレフィックス 24,010 tok のヒット有無——attempt 5・7 のターン1 `cacheRead=24,010` が warm、attempt 6 は `cacheRead=0` の cold)。**教訓: ネスト claude のコスト測定は「同日・同バージョン・warm 統制」の同時比較でのみ成立する。** 過去ラウンドの絶対額は 2.1.77 会計として読むこと。

#### 同日 3-way 再測定(2026-07-07 午後、全 run 2.1.202・warm・sandbox 無効)

| 実行 | 判定 | orch 実測 | turns | 完全性 | フル推定(warm) |
|---|---|---|---|---|---|
| baseline(Sonnet 単独) | PASS | $0.4458 / 97s | 19 | 完走 | $0.446 |
| 手組み(3× `lh -p`)1回目 | FAIL | $0.4228 | 16 | 1/3 委譲後に環境死 | —(参考値) |
| 手組み(3× `lh -p`)再試行 | PASS | $0.5643 / 753s | 17 | 3/3 委譲 ok・検証/feedback 前に環境死 | **≈$0.60+** |
| `lh batch`(attempt 6、cold) | PASS | $0.5257 / 887s | 8 | **完全**(検証+sha256ガード+feedback 3件) | **$0.389**(warm 換算) |
| `lh batch`(attempt 7、warm) | PASS | $0.3400 / 1966s | 5 | 検証/feedback 前に環境死 | **≈$0.42**(欠落ターン加算) |

warm 換算は実測に基づく厳密計算(attempt 6 のターン1書き込み 35,592 のうち共有プレフィックス 24,010 を read に振替)、フル推定は attempt 6 の該当ターン実測(検証+feedback+サマリ=+$0.083)を加算。ローカル側: attempt 6 = 792s/23ターン、attempt 7 = 1689s/21ターン(同一タスクで2.1倍の分散)、手組み再試行 = 3セッション計355s。バッチ2 run とも per-task check は全て exit 0・attempts 1・再検証スイープ退行なし。attempt 6 は feedback 3件を各タスクの検証内容付きで記録。

#### 発見

1. **新会計では「文脈税」が支配的になり、一級 `lh batch` だけが黒字**: 手組み逐次委譲はフル ≈$0.60+ で baseline($0.446)比 **+27%以上の赤字**に転落(2.1.77 会計では黒字だったパターン)。`lh batch` はフル ≈$0.39〜0.42 で baseline 比 **−6〜13%** の黒字を維持し、対手組みでは **≈−30%**。プレフィックス肥大でオーケストレータの1ターンが高くなったため、「N 回の `lh -p` 呼び出し+結果処理ターン」を「1回の `lh batch`」に畳むターン数削減そのものが、旧会計時より大きな価値を持つようになった。**第5ラウンドの結論(束ねろ)は保持されるが、束ね方は手組みではなく一級コマンドであるべき、に更新**。
2. **プロトコル信頼性はバッチ側が構造的に有利**: 手組み1回目は3件中1件しか委譲できないまま死亡し FAIL(perf が O(n²) のまま)。`lh batch` はマニフェスト受理後の実行・check・修復・永続化が全てローカル側で完結するため、オーケストレータがいつ死んでも「委譲済みの仕事」は完遂される(2 run とも 3/3 ok)。
3. **per-task 実効費(warm フル推定)**: バッチ $0.130〜0.140 / baseline $0.149 / 手組み $0.19〜0.20+。第5ラウンドの「バッチ 1件 $0.064」は 2.1.77 会計の値。単発委譲 floor(S+T)の 2.1.202 再測定は未実施(宿題)。
4. **ローカル壁時計は分散が支配的(宿題)**: バッチのアーカイブ6 run でローカル合計は 333s〜1688s(5倍)。per-task の `durationMs` で分解すると docs 級 80→993s・types 級 179→865s と単一タスク内の分散が主因で、ターン数はほぼ同じまま per-turn 時間だけ伸びる run がある(Ollama 側の状態を疑う)。最速 run(333s)は手組み3連発(355s)と同等なので「一級 batch が構造的に遅い」は不成立だが、n=1 の壁時計比較が従来想定(±10%)より遥かに信頼できないことが確定した。
5. **オーケストレータのプロトコル遵守は run 毎に揺れる**: attempt 6 は指示外の品質行動(保護ファイルの sha256 事前記録)まで行い feedback も完備、attempt 7 と手組みは(死亡もあり)feedback 未記録。nudge で全てを固定することはできず、**受け入れゲートを check としてローカル側に置く設計**(第3ラウンドの結論)が引き続き正しい。

#### 総括(第6ラウンド)

`lh batch` 一級化は**機能面で完全合格**(2 run 連続でローカル 3/3・check 全て初回通過・修復ループ発火ゼロ・再検証スイープ退行ゼロ)。経済面では、CLI 2.1.202 の会計変更という向かい風の下で**唯一黒字を維持した委譲形態**となり、手組み逐次委譲(旧推奨)は赤字化したため運用推奨を `lh batch` に一本化する。全セル n=1、ローカル壁時計の分散が大きい(±2倍)点は従来以上に留意。測定プロトコル(同日・同バージョン・warm・アーカイブ&リトライ)と間欠 ConnectionRefused の回避運用は上記の通り文書化した。
