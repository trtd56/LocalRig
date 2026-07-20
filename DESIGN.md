# LocalRig 設計ドキュメント

Qwen 3.6 27B (MTP, Ollama) 向けコーディングエージェントハーネス。
目標: Claude Code (Sonnet) と同等のコーディングタスク遂行能力。

## 前提・実測値

- モデル: `hf.co/InternScience/Agents-A1-Q4_K_M-GGUF:Q4_K_M` (arch qwen35moe, 34.7B MoE, Q4_K_M, 22GB)。2026-07-21 に旧既定 `qwen36-27b-mtp:latest` (arch qwen35, 27.3B, Q4_K_S, 16GB) から切替 — 全20 evalタスク同等品質で wall-clock 約2.7〜3.6×高速 (eval/REPORT.md「Agents-A1 比較ラウンド」)
- モデル宣言コンテキスト長: 262,144 / 実運用 `num_ctx`: 既定 **32,768**(VRAM に余裕があれば `LH_NUM_CTX=65536` 推奨。64GB RAM機で KV キャッシュが常駐 LLM ジョブと衝突しない範囲で設定)
- Capabilities: `tools` (ネイティブFC), `thinking` — 実測でネイティブ並列ツールコール動作確認済み
- Ollama chat API は `prompt_eval_count` / `eval_count` で実トークン数を返す → 文字数推定を毎ターン実測で補正する

## ローカルLLMの弱点と対策(本ハーネスの核)

### A. ToolUse 強化
1. **ネイティブFC + テキストフォールバック**: `tool_calls` を第一とし、content中の `<tool_call>{...}</tool_call>` JSONブロックもパース(Qwenが崩れたときの保険)
2. **スキーマ検証 + 修復ループ**: 引数をJSON Schemaで検証。失敗時はエラー内容を具体的に tool result として返し再試行(最大3回)。二重エンコードJSON(`"{\"path\": ...}"`)の自動アンラップ、型強制(string→number/bool)、ツール名のファジーマッチ(case/snake/camel正規化 + 編集距離1)
3. **ミニマルで直交するツールセット**: read / write / edit / bash / grep / glob / todo。説明文に使用例・禁止事項を明記
4. **ループ検出**: 直近ツールコールのハッシュ列を監視。同一コール3回で警告注入、5回で強制停止。同一エラー繰り返しも検出
5. **サンプリング**: temperature 0.6 / top_p 0.95 / top_k 20 / presence_penalty 1.0(前者3つはQwen3.6モデルカードのthinkingモード・コーディング推奨値。低温度はthinking時に反復ループを誘発するため0.2は不可。presence_penalty は Qwen 公式の反復対策レバー — thinking プリセット1.5 / coding 0.0 の中間として1.0を採用し、観測された推論ループを打破。`--presence-penalty` / `LH_PRESENCE_PENALTY`)
6. **切断応答のedit/write拒否**(qwen-code由来): done_reason=length の応答に含まれる mutating ツールコールは実行せず再発行を要求(不完全なJSONでのファイル破壊防止)
7. **editの多段マッチングカスケード**(OpenCode/pi由来、弱いモデルに最重要): exact → 正規化(BOM/CRLF/NFKC/末尾空白/スマートクォート/ダッシュ) → 行トリム → エスケープ正規化(リテラル\n→改行) → ブロックアンカー(先頭・末尾行一致、±25%サイズ許容)。各段は一意マッチのみ採用。マッチ範囲がold_stringの3倍超なら拒否
8. **write ガードレール**: 既存30行以上のファイルの全書き換えは `overwrite: true` 必須(無ければ edit を促す in-band エラー)。内容が完全一致する write はディスクに触れず no-op。読んだ上での全書き換えによるコード欠落(eval・実運用の双方で観測)を防止

### B. コンテキスト管理強化
1. **トークン会計**: ollama実測値でメッセージ毎のコストを記録。推定器(chars/3.3)は事前見積りのみに使用し、毎ターン実測で校正
2. **ツール出力トランケーション**: bash ≤30k chars (head+tail保持)、read ≤2000行かつ1行≤2000chars(offset/limitページング)、grep ≤100件。切り詰め時は「何が切れたか・続きの取り方」を明記
3. **プルーニング(第一段階)**: コンテキスト75%到達時、古いツール結果(直近Kターンより前)を `[pruned: 再取得可]` スタブに置換。同一ファイルの再readは旧結果を自動スタブ化。ゲート判定は `推定 + headroomTokens`(次応答用の余裕、既定4096・`LH_HEADROOM`)で行う — 旧実装は num_predict 全量(16384)を足していたため実使用25%程度で早発し、コンパクションのたびに Ollama プレフィックス KV キャッシュを破壊して再prefillコストを払っていた
4. **コンパクション(第二段階)**: 85%到達時、会話全体を構造化サマリ(目標/完了/進行中/触ったファイル/学び/次の一手)に要約し、直近メッセージ+システム+todo状態を保持して再構築
5. **todoリスト常時注入**: 弱いモデルの脱線防止。ターン毎に現在のtodo状態をsystem-reminderとして注入。コンパクション後も維持

### C. エージェントループ
- ReActループ、max 60イテレーション
- ストリーミング表示(thinkingはdim表示)
- **thinking ウォッチドッグ**: eval で壁時計時間の46%が thinking 生成に消費(最悪ケース14,454字の暴走ブロック)。出力(content/tool_call)が始まる前に thinking が `thinkBudgetChars`(既定6000字≈1,800トークン≈decode約3分・`--think-budget`)を超えたら AbortController でそのターンを中断。thinking は再送されず content 開始前に中断するため損失は僅少。中断後は「最善の仮説を1-2文→即ツール検証」を促す user メッセージを注入して再試行。1ターン最大2回、2回目は `think:false` で再試行。判定は純関数 `shouldInterruptThinking` に分離(ユニットテスト可能)
- **実時間予算**: `--max-time SECONDS`(`LH_MAX_TIME`、既定0=無効)。stdin/manifest取得からmodel stream・tool・check・修復turn・batch最終sweepまでコマンド単位の絶対deadlineを共有し、超過時は新しいwrap-up turnを開かずstatus=`timeout`で終了する。shellは独立process groupへTERM/KILLを送り、`setsid`等で離脱した子孫PIDも追跡して停止する。出力はbounded head/tailと0600の逐次spoolへ分離し、spoolは厳格な16 MiB上限(超過/書込み失敗でproducer停止)を持つ
- 割り込み(Ctrl+C)、one-shotモード(`-p`)とREPLモード。ウォッチドッグ中断はユーザ割り込みと区別(ユーザ Ctrl+C のみ status=`interrupted`)
- 許可モデル: REPLのデフォルトはwrite/edit/bashを確認。one-shot/batchは安全側の`auto`が既定で、全path toolをrealpath済みcwd/allow/protect scope内へ制限し、新規pathの既存親symlinkも検査する。変更toolとbashの書込みscopeはhard linkをfail-closedで拒否する。bashはmacOS `sandbox-exec`のdeny-default policyで必要runtime/cwd以外のread、scope外/protected write、network、self以外へのsignal、caller環境を拒否する。非macOSのauto bashは拒否し、sandboxなしhost実行は明示`--yolo --in-place`のみ
- 変更監査: タスク前後の全通常file/symlinkについてbytes・POSIX mode・symlink targetをhashしたsnapshotから、bashを含む最終`changed_files`を生成し、allowed/protected scope違反は失敗にする。git ignore規則は参照せずignored fileも監査し、明示除外はdirectory名`.git`と`node_modules`だけ。最終状態が同じnet-zero一時fileは現れない
- **private Git worktree transaction**: one-shot/batchは`--worktree`が既定。親のHEAD ref/branch/history/indexとstaged・unstaged・untracked・ignored・binary・symlink・POSIX mode・deleteをprivate 0700 storeへ物理copyし、Agent/check/snapshotを論理cwdから分離したcheckoutで実行する。親のobject DB/ref/indexは作成時にも変更しない。最終binary patch/mode manifestを0600でatomic保存後、固定per-user repo lock下で開始HEAD/index/content/mode fingerprintと`git apply --check`を再検証し、成功runだけworking treeへ適用する(HEAD/index不変を事後確認)。batchは全task+workspaceを変更しないfinal sweep成功時のみ一括適用。失敗・timeout・interrupt・競合は親を不変にしてartifactをresumeへ残し、別repo・baseline差・patch/mode SHA不一致はAgent起動前に拒否する。`--in-place`は明示opt-outで、`--yolo`には必須。非Git/unborn/unmerged/submodule/multiply-linked repoは暗黙fallbackせず拒否する
- **durable apply / 隔離ライフサイクル**: apply前に対象bytes/modeのbackupとjournalをfsyncし、lockへjournal pathを記録する。例外とapply中SIGINTはlock保持中にrollbackしてbaseline fingerprintを再検証し、process crashは次のlock取得者がjournalからcommit済み/rollback必要を判定する。finalizationはrun deadlineをdisposeした後の独立30秒予算、rollbackは安全収束まで打ち切らない。正常にfinalize/cleanupできたcheckout/private object storeだけを除去しpatch/manifestを保持するが、finalize/cleanup/rollback failureではcheckoutをretainedにし、finalize前ならmanifestは未生成の場合がある。isolation開始時の保守GCは既定7日より古いdead ownerまたはownerなしorphanを対象にし、live/malformed/symlink storeと未解決journal/backupを削除しない

### D. 前処理レイヤー (`lh distill` / `lh scout` / `lh diff` / `lh research`)
1. **エージェントループなし**: 入力ファイル/stdinはハーネスが読み、ローカルLLMにはツールを渡さない。単発 completion をチャンクごとに走らせ、必要時だけ reduce する。
2. **citation付きJSON契約**: Ollama の `format` JSON schema で `answer` / `not_found` / `citations` / `omitted` / `citations_dropped` を強制する。`-q/--query` は必須で、観点なしの汎用要約は拒否する。
3. **引用の機械照合**: citation の `quote` が対象ファイルの指定行に存在するか確認し、行ズレは近傍±20行→ファイル全体探索で補正する。見つからない quote は drop し、`citations_dropped` に反映する。これにより precision はハーネス側で守り、recall は eval で測る対象に分離する。
4. **消費規約**: digest は地図であって真実ではない。上位エージェントは編集・判断前に cited range を read する。`not_found: true` は正直な不在報告として扱う。
5. **共通結果契約**: `preprocess.ts` の `PreprocessResult` が既存 digest 5フィールドを維持し、入力種別と input/output token、圧縮率、provider prompt/completion の機械計測を追加する。distill/scout/diff/research は全てこの契約を実際の保存結果に使う。
6. **diff snapshot adapter**: unified diff を file/hunk/added/deleted/context 行へ正規化し、old/new line位置を保持する。citation は実ファイルではなく SHA-256 付き取得時snapshotで照合するため、削除行も検証でき、後続のworktree変更にも影響されない。git取得はshellを介さないread-only argv実行。
7. **Web research adapter**: ローカルLLMは質問から検索queryを計画するが、検索API呼び出し・URL canonicalize/dedupe・fetch・HTML正規化・snapshot保存はハーネスが所有する。Brave Search（`BRAVE_SEARCH_API_KEY`）、SearXNG（`LH_SEARXNG_URL` / `--search-url`）、検索なしのdirect URLを同じpipelineへ流す。
8. **Webのtrust boundary**: 取得本文は命令ではなくuntrusted dataとしてpromptへ明記し、ページ内prompt injectionを採用しない。標準fetcherはHTTP(S)以外、credentials、localhost、private/link-local/reserved addressを拒否し、DNS resolutionとredirectの全hopを再検査する。取得本文は `$LH_HOME/research/<session_id>/` にSHA-256名で保存し、citationのquote/offset/hashはそのimmutable snapshotへ照合する。
9. **researchの消費規約**: citation検証は「そのquoteが取得時snapshotに存在した」ことだけを保証する。digestは地図として使い、上位エージェントは保存snapshot、source date、矛盾を確認してから結論に使う。観点なしのgeneric summaryは作らず `-q/--query` を必須とし、kind既定`research`のfeedback/statsで実績を蓄積する。

### E. 永続化・実績ルーティング

1. **session / feedback schema v2**: v1を読み込み時に互換変換する。sessionは最終turnと全turnを区別した`prompt_last`/`prompt_total`/`completion_total`、`total_ms`と任意の`model_ms`/`tool_ms`/`check_ms`/`ttft_ms`、isolation lifecycle、実行dimensionを保存する。feedbackは`accepted_as_is`/`accepted_after_resume`/`rejected`、failure code、rework時間、caller input/output/cache tokenとcost receiptを持つ。
2. **durable session update**: 0600 temp fileをfsync→atomic rename→directory fsyncする。detached親/workerの競合は単調増加`generation`のcompare-and-swapで検出し、完了recordを古い`running` placeholderで上書きしない。feedback JSONLもper-file lock下で末尾破損を回復してappendする。
3. **比較dimension**: model/hardware/caller/integration version/LocalRig versionと取得元・取得不能理由をrun開始時にstampする。stats filterはmodel/hardware/callerを扱い、requested dimensionが欠けるhistorical runを一致扱いせず`unknown`へ分離する。`dimensionCoverage`はmatched/unknown/excludedを公開する。
4. **保守的な実績gate**: coverage、rework率、p50/p90、95% Wilson成功率下限を集計する。既定ではgraded 3未満またはfeedback coverage 50%未満を`insufficient_data`、Wilson下限50%未満を`block`とするため、未採点runやdimension欠損を成功証拠に数えない。
5. **`lh advise`**: strict parserで受けたtask factsから、安い順に`direct`/`script`/`delegate`/`batch`/`distill`/`scout`/`diff`/`research`の8 routeを返す。Local LLM routeはriskがlow/medium、客観checkあり、実績gate allow、coverage 50%以上、rework 25%以下、指定p90 latency内を共通条件とする。実装委譲はさらにsize既知・cost floor以上・明示kindが必要。未知/high risk、欠損値、insufficient evidenceは`direct`へ倒し、機械化できる変換はmodelを呼ばない`script`を優先する。

## モジュール構成

```
src/
├── index.ts          # CLIエントリ(REPL / -p one-shot)
├── agent.ts          # エージェントループ(コア)
├── advice.ts         # 8-routeの保守的な委譲/前処理ルーター
├── session.ts        # schema v2 session/feedback、atomic CAS、stats/Wilson gate
├── workspace-snapshot.ts # ignoredを含む最終変更監査とscope検証
├── distill.ts        # 前処理コア(チャンク計画、digest parse、citation照合、map-reduce)
├── preprocess.ts     # distill/scout/diff/research 共通の結果・metrics契約
├── diff.ts           # unified diff parser、snapshot citation adapter
├── research.ts       # Web検索/fetch/正規化、SSRF防御、snapshot citation adapter
├── config.ts         # 設定(model, num_ctx, temperature, limits, permissionMode)
├── permissions.ts    # 許可モード判定(autoは機械sandboxを前提に承認)
├── isolation/
│   ├── types.ts      # worktree handle/artifact/session metadata/GC契約
│   └── worktree.ts   # private Git snapshot、journal/rollback、apply/cleanup/GC
├── runtime/
│   ├── deadline.ts   # command-scoped absolute deadline/AbortSignal
│   └── process.ts    # descendant kill、bounded output、16 MiB spool
├── provider/ollama.ts    # Ollama chat APIクライアント(stream, tools, thinking, token実測)
├── prompt/system.ts      # システムプロンプト生成(環境情報埋め込み)
├── batch.ts / check.ts # batch集約・final sweep / acceptance process
├── tools/
│   ├── registry.ts   # ToolDef登録・ディスパッチ（共通型はsrc/types.ts）
│   ├── read.ts write.ts edit.ts bash.ts grep.ts glob.ts todo.ts
├── toolcall/
│   ├── validate.ts   # スキーマ検証・型強制・名前ファジーマッチ・修復メッセージ生成
│   └── loopdetect.ts # 反復検出
├── context/
│   ├── tokens.ts     # トークン会計(実測校正付き推定)
│   └── manager.ts    # prune/compact、古いread結果のスタブ化
└── ui/render.ts      # ターミナル表示(ストリーム、色、diff表示)

eval/
├── tasks/            # 評価タスク(テスト付き)
├── run.ts            # multi-arm/repeat/seed実行とrun metadata収集
├── analyze-repeated.ts # median/p90/p95、品質・cost集計
├── gate.ts           # 品質非劣性/cost/p95のfail-closed CI gate
└── REPORT.md         # Claude Code出力との比較結果
```

## 調査で確定した設計根拠(pi / OpenCode / qwen-code)

| 項目 | 採用値 | 出典 |
|---|---|---|
| read上限 | 2000行 / 1行2000chars、続きはoffset指定(実用的フッター付き) | pi/OpenCode/qwen-code 全一致 |
| bash上限 | 30k charsのhead+tail保持、0600 temp spoolへ逐次保存。ただしstrict 16 MiB capでproducer停止 | pi/OpenCode/qwen-code + 本ハーネス安全上限 |
| grep上限 | 100件 | pi/OpenCode |
| コンパクション形式 | 構造化サマリ(Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context)+ **機械的なread/modifiedファイルリスト** | pi + OpenCode(anchored summary) |
| サマリ生成 | 平文シリアライズ(会話として継続させない)、tool結果は2000charsに切詰、thinking無効 | pi/OpenCode/qwen-code |
| コンパクション失敗ガード | 空サマリ→中止、圧縮後トークン増→破棄、3連続失敗→サーキットブレーカ | qwen-code |
| ループ検出 | 同一コール連続3で警告/5で停止、per-turn上限、ABAB検出 | qwen-code(5で停止)/OpenCode(3でエスカレーション) |
| ツールコール修復 | 名前ケース修復→エイリアス→編集距離、不正コールはin-bandエラー結果として返す(リクエストを落とさない) | OpenCode(invalidツール)/pi(修復→検証→エコー) |
| 最大ステップ到達時 | ツール禁止でテキストのみの強制サマリを注入 | OpenCode(MAX_STEPS_PROMPT) |
| num_ctx | ≥16k必須(4kだとスキーマが切れてtool calling が静かに壊れる)、本機は32768(65536だと27BのKVキャッシュが常駐LLMジョブと衝突しメモリ枯渇) | OpenCode docs |
| thinking再送 | しない(コンテキスト節約、Ollamaテンプレートが最終ターンのみ描画) | Qwen既定テンプレート挙動 |
| システムプロンプト | 小型(<1500トークン)+ツール利用例。巨大プロンプトはfrontierモデル前提の逆張り不要 | pi(<1000トークン)、ただし27Bには例示を追加 |
| サブエージェント統合方式 | CLIプロセス起動(`-p --json`)+ session/feedback ファイル。MCPサーバ化(stdio/SSE)は検討の上見送り | 常駐サーバのプロセス管理・ライフサイクル管理を増やさずに構造化結果・検証可能なログ・非同期フィードバックを既に満たせるため |

## 評価方法

各タスクを (1) 本ハーネス+Qwen3.6 (2) Claude Code で実行し、
自動テスト通過率・修正要否・イテレーション数を比較して REPORT.md に記録。

再現可能な比較では`eval/run.ts --arms <a,b> --repeat N --run-id ID --order-seed SEED`を使い、反復ごとにsummary/log/LH_HOME/worker結果を分離する。run metadataはrepeat番号、seed、実際のarm順、process内cold/warmラベル、git commit/dirty、model名/digest/quantization、Ollama/Claude/caller version、GPUを保存し、取得不能値を理由付き`null`にする。`bun run eval:analyze -- --run-id ID`はmedian/p90/p95、品質成功率、caller cost節約を集計する。`bun run eval:gate -- --run-id ID ...`は品質非劣性・最小節約・candidate p95の三条件を検査し、sample/paired metadata/測定値の欠損・重複・破損もnonzeroでfail-closedにする。cold/warmは実行順ラベルであり、モデルを強制unloadした保証ではない。詳細は`eval/README.md`。

タスク例:
1. 単機能実装: 仕様からモジュール+テストを書く
2. バグ修正: 既存コードのテスト失敗を直す
3. マルチファイルリファクタ: 既存小規模プロジェクトの構造変更

research adapterはライブWebと実モデルから切り離した固定fixtureでも評価する。ephemeral HTTP serverに、3ページへ分散した正解、canonical重複、巨大noise、答えなし、本文中prompt injection、古い矛盾資料を置き、fake completionでpipelineとcitation verifierを決定的に通す。2026-07-08時点の結果は citation precision=1、植込みcitation recall=1、32,784→375 tokens（圧縮率0.0114）、取得7ページ。これはadapterの決定的回帰試験であり、ライブWeb品質、実モデル品質、上位モデルのコスト削減を測った値ではない。`claude-research` armはsession kind、citation drop、圧縮率等を集計する足場までで、baselineとの同日n=3実測は未実施。

## モデル更新手順

### 切り替えの入口
- `LH_MODEL` 環境変数(または `--model` CLIフラグ)でモデル名を指定する。
- `LH_KEEP_ALIVE`はOllama runnerの常駐時間(既定`30m`)。メモリを即時解放する場合は`0`。
- `LH_NUM_BATCH`はprefill計測用のOllama `num_batch` override。未指定ならserver/model既定。
- サンプリング値(temperature/top_p/top_k/presence_penalty/thinkBudgetChars)は `src/config.ts` の `MODEL_PROFILES`(モデル名の大文字小文字無視・部分一致、先勝ち)から `resolveProfile()` が自動解決する。優先順位は「CLIフラグ/環境変数(`LH_TEMPERATURE` 等)で明示指定 > `MODEL_PROFILES` のパターンマッチ > どのパターンにも一致しない場合は検証済みQwen値(`DEFAULT_PROFILE`)にフォールバック」——未検証のモデルを未検証の値ではなく既知の安全値に倒す設計。
- 新モデル系統を採用する場合、`MODEL_PROFILES` に1エントリ(パターン文字列 + `ModelProfile` の5フィールド)を追加する。

### 回帰確認
手順は eval/README.md の「モデル更新時の回帰手順」節を参照。要旨: 新モデルで harness アーム全タスクを実行 → `eval/compare-baseline.ts` で `eval/baselines/qwen36-27b-mtp.json` と突き合わせ → 退行がなければ新モデルの baseline を保存・コミット。

### 再計測チェックリスト
以下は Qwen3.6 の実測で決めた値・挙動であり、モデル更新時に再計測・再確認する:
- **presencePenalty**: Qwen のループ対策として実測で決定(`src/config.ts` のコメント参照)。
- **thinkBudgetChars**: 文字ベースの thinking watchdog。thinking の冗長度はモデル依存。
- **think パラメータの扱い**: `src/provider/ollama.ts` は `think` オプションを未指定なら送らずモデルのデフォルトに委ねる。新モデルが thinking 非対応、または別形式で thinking を返す可能性がある。
- **opt-in thinking 解決**: one-shot/REPL/batchは明示`--think`/`--no-think`、task manifestの`think`、`LH_THINK_BY_KIND="docs:off"`を優先順位付きで解決する。map既定は空で、品質ゲート前に既定挙動を変えない。
- **干渉の可観測性**: providerの`total_duration`からqueue残差とclient overheadを加算保存する。command/task境界の`/api/ps` snapshotとeval中の30秒watcherで外来digest sampleを品質・速度判定から除外する。
- **loopWarnAfter / loopAbortAfter**: 反復傾向はモデル依存。
- **システムプロンプト**: `src/prompt/system.ts` は ~27B 向けに短く命令調で書かれている。モデルの規模・性格に応じて調整の余地がある。
- **ツールコール形式**: `src/toolcall/fallback.ts` は Qwen の `<tool_call>{...}</tool_call>` ブロック → fenced ```json ブロック → bare JSON という優先順位でテキストからツールコールを復元する。新モデルが生成するツールコール崩れの形式が異なる場合、eval ログから生出力を採取して `test/toolcall.test.ts` にフィクスチャを追加し、必要ならパーサ段を1つ足す。eval ログの「⚠ tool-call repair」出現率がモデル比較の指標になる。
- **Ollama 側テンプレートの tool-call / thinking 対応確認**(`models/README.md` 参照)。
- **委譲基準の再校正**: `integrations/claude-code/delegate-local/SKILL.md` のタスク選定基準・損益分岐コストも Qwen3.6 の実測に基づく校正値のため、モデル更新時は eval の delegate アーム(eval/README.md 参照)を回し直して再導出する。

### 自動追従するので再計測不要
- **トークン推定**: `src/context/tokens.ts` は `prompt_eval_count` への EMA 自己校正なので、モデルが変わっても自動的に追従する。
- **prune/compact 閾値**: `src/config.ts` の `pruneAt`/`compactAt` は `numCtx` に対する比率で決まるため、モデル固有のコンテキスト長に自動的にスケールする。
