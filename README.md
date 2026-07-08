# LocalRig

Ollama 上のローカル LLM(既定: Qwen 3.6 27B MTP)を Claude Code 級のコーディングエージェントとして動かすためのハーネス。

ローカルモデルの二大弱点 — **ツールコールの脆さ** と **コンテキスト管理の甘さ** — を、pi / OpenCode / qwen-code の実証済みテクニックを移植して補強している。設計の詳細と出典は [DESIGN.md](./DESIGN.md) を参照。

## 必要環境

- [Bun](https://bun.sh) ≥ 1.2(CLI/shebang・install・testに必須。packageのNode互換targetは≥24だが、Node単体起動は非対応)
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
localrig -p "タスク" --json --check "bun test"  # 機械向け: JSON 1行を stdout に出力

# 既存連携向けに `lh` も同じCLIとして利用可能
lh -p "タスク"
lh submit -p "タスク" --json  # detached 実行
lh wait <session_id> --json   # detached 実行の完了待ち

# 実績・リスク・サイズから cheapest safe route を機械判定
lh advise --task "4ファイルのAPI移行" --kind types --files 4 --lines 600 \
  --check --risk low --batch-candidates 2 --caller codex --json

# 大きなログ/ファイルを上位エージェントに渡す前に citation 付きで圧縮
bun test 2>&1 | lh distill -q "落ちたテストの根本原因は?" --json
lh distill -q "リトライ処理はどこに実装されている?" src/**/*.ts

# 探す場所からローカルに任せる read-only scout
lh scout -q "リトライ処理の定義・登録・呼び出し元はどこ?" --paths src --json

# stdin の unified diff、または cwd の git diff をスナップショット検証付きで圧縮
git diff --staged | lh diff -q "レビュー上のリスクと挙動変更は?" --json
lh diff -q "破壊的変更はある?" --base main --cwd /path/to/repo --json

# Web検索または指定URLを取得し、保存snapshotに裏付けられたevidence bundleへ圧縮
BRAVE_SEARCH_API_KEY=... lh research -q "2026年時点の変更点と根拠は?" --max-results 8 --max-pages 5 --json
lh research -q "この2資料の相違点は?" https://example.com/a https://example.com/b --json
```

| フラグ | 意味 |
|---|---|
| `-p "..."` | ワンショットモード(CI/スクリプト/エージェント向け)。`-p -` で stdin から読む |
| `--json` | 結果を JSON で出力し進捗を抑制(`-v` 併用で stderr に進捗) |
| `--quiet` | stderr への進捗表示を抑制 |
| `--cwd DIR` | 実行ディレクトリ指定 |
| `--model NAME` | モデル上書き(env: `LH_MODEL`) |
| `--num-ctx N` | コンテキスト窓(env: `LH_NUM_CTX`、既定 32768。VRAM に余裕があれば `LH_NUM_CTX=65536` 推奨) |
| `--num-predict N` | 1ターンあたりの最大生成トークン(既定 16384) |
| `--temperature T` | 既定 0.6(Qwen3.6 thinking 推奨値) |
| `--presence-penalty P` | 反復抑制ペナルティ(env: `LH_PRESENCE_PENALTY`、既定 1.0。Qwen 公式の反復対策レバー) |
| `--max-iterations N` | エージェントループ上限(既定 60) |
| `--max-time SECONDS` | コマンド全体の実時間予算。model/tool/checkへ同じdeadlineを伝播し、超過時はプロセスツリーも停止してstatus=`timeout`。`0` で無効(env: `LH_MAX_TIME` 秒、既定 0) |
| `--think-budget CHARS` | 出力開始前の thinking がこの文字数を超えたらそのターンを中断・再試行(env: `LH_THINK_BUDGET`、既定 6000)。1ターンにつき最大2回まで、2回目は thinking を無効化して再試行 |
| `--headroom TOKENS` | prune/compact ゲート判定で現在推定に上乗せする予約トークン(次の応答用の余裕)。`num_predict` ではなくこれを使う(env: `LH_HEADROOM`、既定 4096) |
| `--check COMMAND` | ワンショット完了後に受け入れコマンドを実行。失敗時は出力末尾をモデルへ戻して自己修復を試みる |
| `--check-retries N` | `--check` 失敗後の修復試行回数(既定 2) |
| `--kind KIND` | 委譲種類タグ。推奨語彙: `rename`, `tests`, `docs`, `types`, `perf`, `bugfix`, `other` |
| `--caller NAME` | 上位エージェント/連携名を実行dimensionへ記録(env: `LH_CALLER`) |
| `--hardware ID` | 比較に使う安定したhardware profile ID。省略時はCPUから自動検出(env: `LH_HARDWARE`) |
| `--integration-version V` | caller側integrationのversionを記録(env: `LH_INTEGRATION_VERSION`) |
| `--allow-path PATH` | path toolのread/mutationとbashのwrite可能範囲をcwd内PATHへ限定(複数指定可)。sandboxed bashのreadはcwd全体 |
| `--protect-path PATH` | path toolのmutationとbash writeを禁止するPATH(複数指定可)。readは許可 |
| `--worktree`, `--isolate` | private Git worktreeで実行し、成功時だけ検証済みpatchを戻す(ワンショット/バッチの既定) |
| `--in-place` | private worktreeを使わず、従来どおり指定cwdを直接変更する |
| `--resume ID` | 保存済みセッションの transcript を復元し、`-p` の指示を追撃として追記して再実行(ワンショット専用)。新 `session_id` を発行し `resumed_from` を記録。`--cwd` 未指定なら元セッションの cwd を継承。不明IDは `error_kind:"config"` |
| `--auto` | cwd/scope境界とmacOS sandboxの下で自動承認(ワンショット/バッチの既定) |
| `--yolo` | sandboxなしのhost bashを明示的に許可(private worktreeとは併用不可で、`--in-place`が必要) |
| `-v` | 詳細表示(ツール出力・トークン使用量) |

ワンショット/バッチはprivate worktreeと安全側の `--auto` が既定。開始時のHEAD/branch/history/indexをprivate Gitへ物理copyし、staged・unstaged・untracked・git-ignore対象、symlink、実行bit以外を含むPOSIX modeまで作業状態を再現する。モデル・修復turn・check・最終scope監査はすべて `$LH_HOME/isolation/<session_id>/` 内で動く(`node_modules`は複製しない)。status/check/scopeが成功した場合だけ0600のbinary patch/mode manifestを先に永続化し、親のHEAD ref/index/全内容が開始時fingerprintと一致することを固定repo lock下で再確認してからworking treeへ一括適用する。one-shotのcheckが作る意図した変更は成果に含める一方、batchの最終再検証sweepがworkspaceを変更した場合はapply前に失敗させる。apply前backup+journalもfsyncし、通常例外とapply中のSIGINTはbackupからrollbackしてfingerprintを再検証する。process crashはlockに記録したjournalから次のlock取得時に復旧する。失敗・timeout・割り込み・競合では親を変更せず、finalize済みならpatch/manifestをresume用に残す。暗黙のin-place fallbackはなく、非Git・unborn HEAD・unmerged index・submodule・multiply-linked fileを含むrepoは理由を表示して拒否するため、直接変更を受け入れる場合だけ明示的に`--in-place`を使う。

`--auto`ではread/write/edit/grep/globをrealpath済みcwd/scope内へ制限し、新規writeも既存親をrealpathするため親symlink経由の脱出を拒否する。変更toolとsandboxed bashは複数hard linkを持つ書込み対象をfail-closedで拒否する。autoのbashはmacOS `sandbox-exec`のdeny-default policyで、cwd/scope・必要runtime以外のread、scope外/protected pathへのwrite、network、self以外へのsignalを拒否し、HOME/TMPDIRと環境変数も隔離する。macOS以外ではautoのbashを安全に拒否する(非bashのscope制約toolは利用可能)。sandboxなしのhost実行が本当に必要なら、private隔離を捨てることが明確になるよう`--yolo --in-place`を両方指定する。

`--max-time` はstdin/manifest取得からmodel、tool、check/repair、batch最終sweepまで同じ絶対deadlineを伝播する。中断時はshellのprocess groupへTERM/KILLを送り、`setsid`等でgroupを離れた子孫PIDも追跡して停止する。stdout/stderrはメモリ上ではbounded head/tailだけを保持し、0600 spoolへ逐次書き出すが、spoolは厳格な16 MiB上限で、超過または書込み失敗時はproducerを停止する。isolation finalizationはrun deadlineとは独立した30秒予算を持ち、apply rollbackは途中で打ち切らず親を安全な状態へ収束させる。

終了コード: `0` = 完了、`1` = 途中終了(ループ検出・上限到達・実時間超過・エラー)、`130` = 割り込み。

## Claude Code / Codex からの委譲とフィードバック

上位エージェント(Claude Code / Codex)が簡単なタスクをローカル LLM に投げてトークンを節約するための仕組み。ワンショット実行は毎回 `~/.localrig/sessions/` にセッションとして記録され、呼び出し側が検証後に採点を返せる。

```sh
lh -p - --json --cwd /path/to/repo --kind bugfix --check "bun test test/foo.test.ts" <<'EOF'
src/foo.ts の null チェック漏れを修正。
完了条件: bun test test/foo.test.ts が通ること。
EOF
# → {"session_id":"...","status":"ok","check":{"exit_code":0,...},"report":{"changed_files":[...],"commands_run":[...]},...}

# 比較可能な実行dimensionを安定したラベルで付与する例
LH_CALLER=claude-code LH_HARDWARE=mac-m4-64gb \
LH_INTEGRATION_VERSION=delegate-local-2026-07 \
  lh -p "タスク" --json --cwd /path/to/repo --kind bugfix --check "bun test"

# 呼び出し側が report.changed_files と diff を確認したあと採点(必須のプロトコル):
lh feedback 20260703-141530-a1b2 pass --source claude-code --notes "tests pass"
lh feedback 20260703-141530-a1b2 fail --source claude-code --notes "別ファイルを編集していた"
# 差し戻し後に受理した場合は再作業量と呼び出し元receiptも残せる:
lh feedback 20260703-141530-a1b2 accepted_after_resume --source claude-code \
  --failure-code wrong_scope --rework-ms 120000 \
  --caller-input-tokens 1200 --caller-cache-read-tokens 800 --caller-cost-usd 0.02

lh sessions        # 最近のセッション一覧(採点状況つき)
lh stats           # 委譲の合格率と直近の失敗ノート(委譲判断の較正に使う)
lh stats --by-kind # coverage・再作業率・p50/p90・95%成功率下限・gate.status
```

`pass` / `fail` は互換エイリアスで、保存時はそれぞれ `accepted_as_is` / `rejected` になる。差し戻しで直した結果を最終的に受理したときは `accepted_after_resume` を使う。セッションJSONの `tokens` は `prompt_last`、全turn合計の `prompt_total`、`completion_total` を持ち、旧reader向けの `prompt` / `completion` も残す。`durations` は `total_ms` に加えて provider が計測できる `model_ms` / `tool_ms` / `check_ms` / `ttft_ms` を持つ。

`--json` の `report.changed_files` は実行前後のbytes・POSIX mode・symlink target snapshotから作られ、`write` / `edit` に加えて `bash` 経由の変更・削除・rename(削除+作成)、untracked、**git-ignore対象**も含む。snapshotが明示的に除外するdirectory名は高容量の `.git` と `node_modules` だけで、実行中に作って消した最終差分ゼロのファイルは現れない。したがって呼び出し側の最終diff/対象file確認は省略しないこと。`report.commands_run` はモデルがbashツールで実行したコマンド列。allow/protect違反が最終snapshotで見つかった場合は成功扱いにせずscope violationで失敗する。

**独立した委譲向きタスクが複数あるなら、1件ずつ `lh -p` を呼ばず `lh batch` で1コールに束ねる**(第6ラウンドで一級サブコマンド化):

```sh
lh batch --tasks - --json --cwd /path/to/repo --max-time 1800 <<'EOF'
{"tasks":[
  {"id":"docs-sync","kind":"docs","check":"cd docs && bun test","allowed_paths":["docs"],"protected_paths":["docs/src","docs/test"],"prompt":"docs/README.md を docs/src/cli.ts の実装に同期。src/ と test/ は変更禁止。"},
  {"id":"typefix","kind":"types","check":"cd typefix && bunx tsc --noEmit","prompt":"typefix/ の型エラーを any/ts-ignore なしで解消。"}
]}
EOF
# → {"session_id":"...","status":"ok","tasks":[{"id":"docs-sync","status":"ok","check":{"exit_code":0,...},...},...]}

lh feedback <session_id> --task docs-sync pass --source claude-code --notes "..."   # タスク単位で採点
```

各タスクは独立の `id`/`kind`/`check` を持ち、任意の `allowed_paths` / `protected_paths` でscopeを機械的に狭められる(CLIのscopeとの積集合で、manifestから拡張はできない)。タスク毎にcheck+修復ループが走り、タスク間で文脈はリセットされる。部分失敗は次の独立タスクへ続行し、全タスク完了後に**再検証スイープ**(通過済みcheckの再実行)で兄弟タスクの副作用による巻き戻しを検出する。既定のprivate worktreeでは、全タスクと最終スイープが成功した場合だけbatch全体のpatchを1回適用し、partial/failedなら親は開始時のまま成果patchを保持する。`--max-time` は**バッチ全体**の総実時間予算(予算切れの未着手タスクは `not_run`)。進行状況はタスク完了毎にセッションへ逐次保存されるため、呼び出し元が途中で死んでも完了済みタスクの成果・check結果は残る。

呼び出し元が**ローカル実行と無関係な別作業を並行で進めたい**ときは detached 実行を使える。ただし headless(`-p`)の自動委譲では原則不要——単一タスクの submit→即 wait は実効ブロック時間が同期 `lh -p` と変わらずターン増で +33% 高くつき(単一タスクは同期実行が正解)、委譲向き A を投げて別作業 B を裏で進める本来の使い方でも B≪A のため net 壁時計は縮まなかった(第5ラウンド async-pair 実測)。価値があるのは人間が対話セッションで無関係な別作業を並行する場合のみ:

```sh
lh submit -p - --json --cwd /path/to/repo --kind rename --check "bash test/verify.sh" <<'EOF'
...
EOF
lh poll <session_id> --json
lh wait <session_id> --timeout 1200 --json
```

27B モデルは Ollama 側で実質直列実行になりやすい。複数 `submit` は可能だが、推論資源はキューイングされる前提で使う。

委譲結果が呼び出し元の検証で不合格だったときは、フルの作業指示を書き直さず `--resume` で同一文脈へ「ここだけ直せ」を送れる:

```sh
lh -p "1行目は FIXED: に完全一致させること。そこだけ直す。" --resume <session_id> --json
```

`--resume` は元セッションの transcript を復元して追撃指示を追加実行し、**新しい** `session_id` を発行する(JSON とセッション記録に `resumed_from` が入る)。失敗runに保持patchがあれば、同じrepo・HEAD ref/index/content/modeのbaseline fingerprint・patch/mode SHA-256を確認し、modeも含めて新しいprivate worktreeへ先にreplayするため、親を汚さず途中成果から直せる。transcript内の旧private絶対pathも新checkoutへ置換する。`--cwd` 未指定なら元セッションの cwd を継承し、別repo指定や親workspace変更、patch改変はagent起動前にconflictとして停止する。ワンショット専用(REPL・`lh submit` では使えない)で、不明IDは `error_kind:"config"` のエラーになる。`feedback fail` を付けたあとの差し戻しの標準手段で、再委譲1回分のプロンプト再構築を省ける。差し戻し後も新セッションを検証し、`feedback` を記録し直すこと。

エージェント側の設定はコピーするだけ(詳細な手順・権限設定・トラブルシューティングは [integrations/SETUP.md](./integrations/SETUP.md)):

- **Claude Code**: `cp -r integrations/claude-code/delegate-local ~/.claude/skills/` — 委譲基準・検証・フィードバック必須のプロトコルを定義したスキル
- **Codex**: `integrations/codex/AGENTS-snippet.md` の内容を `~/.codex/AGENTS.md` に追記

データ置き場は env `LH_HOME` で変更可能(既定 `~/.localrig`)。session/feedbackはschema v2で、旧v1 JSONは読み込み時に互換変換される。session更新は0600の一時ファイルをfsyncしてatomic renameし、detached workerと親の更新競合は単調増加`generation`のCASで検出する。tokensは最終turnの`prompt_last`と全turn合計の`prompt_total`/`completion_total`、durationsは`total_ms`と任意の`model_ms`/`tool_ms`/`check_ms`/`ttft_ms`を保持する。feedbackは`accepted_as_is`/`accepted_after_resume`/`rejected`、failure code、rework時間、caller token/cache/cost receiptを保存できる。

実行時にはmodel/hardware/caller/integration/localrig versionをdimensionとして記録する。`lh stats --model ... --hardware ... --caller ... --by-kind --json`のfilterでは、過去recordにdimensionが無いrunを一致扱いせず`dimensionCoverage.unknown`へ分離する。coverage、rework率、p50/p90に加え95% Wilson成功率下限を出し、既定gateはgraded 3件未満またはcoverage 50%未満を`insufficient_data`、成功率下限50%未満を`block`とする。

正常にfinalize/cleanupできたprivate checkoutは削除し、`isolation`メタデータと0600のpatch/manifestを監査・resume用に保持する。finalize/cleanup/rollback失敗時は診断・復旧用checkoutをretainedにする場合があり、finalize前の失敗ではmanifestがまだ存在しない。repo apply lockは`LH_HOME`と独立した固定per-user pathを使う。isolation開始時に走る保守GCは既定7日より古いdead-ownerまたはownerなしorphanの実行物を対象とし、live PID・symlink・未知/malformed ownerをfail-closedで避け、patch/manifestと未解決apply journal/backupを消さない。

## 委譲ルーター: `lh advise`

`lh advise` は実装を行わず、入力された機械的事実とdimension-filter済みの実績から8経路のどれを使うか返す: `direct`、`script`、`delegate`、`batch`、`distill`、`scout`、`diff`、`research`。未知flagを許さないstrict parserで、JSONにはroute/reasons、sample size、coverage、dimension matched/unknown/excluded、p50/p90、Wilson下限、gateを含む。

```sh
lh advise --task "既知ログから根本原因を抽出" --kind distill \
  --bytes 131072 --check --risk low \
  --caller claude-code --model qwen36-27b-mtp:latest --hardware mac-m4-64gb --json
```

Local LLM経路は共通gateを全て通ったときだけ推奨される。high/unknown risk、客観checkなし、実績の`block`/`insufficient_data`、coverage不足、rework率25%超、指定latency budgetを超える/測れない場合は`direct`へ倒す。実装委譲ではさらにsize既知・cost floor以上・明示`kind`が必要で、規則を機械化できる場合はmodelを呼ばない`script`を優先する。ルーターの出力は許可そのものではなく、上位エージェントが作業内容と検証可能性を確認するための保守的な判断材料である。

## 前処理: `lh distill`

`lh distill` は、大きなログやファイル群を Claude Code / Codex のコンテキストへ直接入れる前に、ローカル LLM で「質問に関係する箇所だけ」を citation 付き JSON に抽出する前処理コマンド。P2時点の発火条件は **1000行以上または64KB以上の入力を、意味的に選別して読む必要があるとき**。この閾値未満、または `grep` / `jq` / `head` / 小さなスクリプトで選別できる場合は直接読む方がよい。

```sh
lh distill -q "落ちたテストの根本原因は?" big-test.log --json
cat build.log | lh distill -q "最初の根本原因だけ。二次 failure は除外"
```

観点なしの汎用要約は作らないため `-q/--query` は必須。出力は `answer`, `not_found`, `citations`, `omitted`, `citations_dropped` を持つ digest JSON で、citation の `quote` はハーネスが実ファイル/行に存在するか機械照合する。見つからない quote は捨てられ、`citations_dropped` に数が出る。

使う前に `lh stats --by-kind --json` を読み、`distill` の `gate.status` が `"block"` なら使わない。`graded < 3` はデータ不足なので、上のサイズ閾値とタスク性質で判断する。

消費側の規約: digest は地図であって真実ではない。編集や結論に使う前に、必ず cited range を自分で read して確認する。`not_found: true` は「無かった」という正直な報告として扱い、都合よく存在を仮定しない。結果の有用性は通常のセッションと同じく `lh feedback <session_id> pass|fail` で記録し、`lh stats --by-kind` の `distill` 実績を委譲判断に使う。

## 前処理: `lh scout`

`lh scout` は、読むべきファイルが分からないリポジトリ横断調査をローカル LLM に read-only で任せるコマンド。使えるツールは `read` / `grep` / `glob` のみで、`bash` / `write` / `edit` / `todo` は渡さない。最終出力は `distill` と同じ citation 付き digest JSON で、citation はハーネスが機械照合する。

```sh
lh scout -q "リトライ処理はどこで定義され、呼び出し元は何箇所?" --paths src --json
lh scout -q "offline reconciliation mode は実装されている?" --json
```

使い分けは三択: 文字列や構造で機械的に拾えるなら `grep` / `rg` / 小さなスクリプト、読む場所が分かっている大入力なら `lh distill`、読む場所から探す必要があるなら `lh scout`。P2時点の scout 発火条件は **自分で調べると5ファイル以上読む見込みの所在調査**。`lh stats --by-kind --json` の `scout.gate.status` が `"block"` なら使わない。scout の digest も地図であって真実ではないため、編集や最終判断の前に cited range を読み直し、`not_found: true` を尊重する。`kind` 既定は `scout` なので、有用性は `lh feedback <session_id> pass|fail` で記録して `lh stats --by-kind` に蓄積する。

## 前処理: `lh diff`

`lh diff` は unified git diff を質問指向で圧縮する。stdin があればその内容を使い、無ければ `--cwd` で `git diff` を安全な argv 実行で取得する。`--staged` と `--base <ref>`、共通の `--budget` / `--think` / `--no-think` / `--max-time` / `--json` を利用できる。

出力は distill/scout と同じ `digest` 互換フィールドに加え、`input_kind` と `metrics` を持つ。diff citation には `path`, `hunk`, `line_type`, `old_line`, `new_line`, `snapshot_line`, `snapshot_sha256` が入り、削除行も取得時の immutable diff snapshot に対して検証される。現在の作業ツリーを再読して検証しないため、取得後の編集や削除行で根拠がずれない。

発火条件は実モデルで未測定のため**暫定**で、まず「そのまま上位モデルへ渡すと大きい diff（目安: 500行または32KB以上）を意味的に選別するとき」に限定する。小さいdiffや `git diff --stat` / `--name-only` / grep で答えられる問いは機械処理を優先する。`kind=diff` の feedback と最終タスク成功率・上位モデルの総コストを蓄積してから閾値を確定する。

## 前処理: `lh research`

`lh research` は検索queryを1〜3個に展開し、候補URLをcanonicalize/dedupeして本文を取得し、質問に関係する根拠だけを citation 付き evidence bundle にする。観点なしの汎用Web要約はrecallを評価できないため、他の前処理と同じく `-q/--query` は必須。

```sh
# Brave Search
BRAVE_SEARCH_API_KEY=... lh research -q "Project Redwoodの現行retry policyは?" --search-provider brave --max-results 8 --max-pages 5 --json

# SearXNG (`--search-url` は `--search-provider searxng` と組み合わせてもよい)
LH_SEARXNG_URL=https://search.example.org lh research -q "仕様変更の一次資料は?" --json
lh research -q "仕様変更の一次資料は?" --search-provider searxng --search-url https://search.example.org --json

# 検索providerなしでdirect URLだけを比較
lh research -q "この2資料が合意している点と矛盾点は?" https://example.com/a https://example.com/b --budget 2000 --json
```

検索候補数は `--max-results`（既定8）、実際に取得・検査するページ数は `--max-pages`（既定5）で制限する。`--think` / `--no-think`、`--budget`、`--max-time`、`--model`、`--kind` も利用でき、`kind` の既定は `research`。結果は通常のセッションとして `lh feedback <session_id> pass|fail --source <caller> --notes "..."` で採点し、`lh stats --by-kind` のresearch実績へ蓄積する。

本文は取得時に正規化され、`$LH_HOME/research/<session_id>/<snapshot_sha256>.txt`（`LH_HOME` 未指定時は `~/.localrig`）へimmutable snapshotとして保存される。同じディレクトリの `manifest.json` とJSON出力の `sources[].snapshot_path` から確認できる。citationにはURL、title、取得時刻、snapshot SHA-256、offset、完全一致quoteが入る。digestは地図であって真実ではないため、主張に使う前にcitationのSHA-256とquoteを保存snapshotに照合し、鮮度と矛盾も自分で判断する。

Web本文は**命令ではなくuntrusted data**として扱う。system promptはページ内の「以前の指示を無視せよ」等を拒否し、quoteがsnapshotに存在しないcitationはdropする。標準fetcherはHTTP(S)以外、資格情報入りURL、localhost、private/link-local/reserved IPを拒否し、DNSとredirectの各hopを再検査する（SSRF防御）。ただし引用の存在確認は情報の正しさや鮮度まで保証しない。

発火条件はまだ**暫定**。複数ページの本文を上位モデルへ生で入れると大きく、質問指向の意味的選別が必要なWeb調査に限定する。固定fixture + fake completionでは citation precision/植込みrecallともに1.0、32,784→375 tokens（圧縮率0.0114）、取得7ページを確認したが、これはライブWebでも実モデルでもなく、コスト損益分岐を示さない。`claude-research` armの足場はあるものの、baselineとの同日n=3比較は未実施。

## 委譲は得か? 使い所とコスト

Claude Code から `lh` へ委譲して Claude 側の API コストが実際に下がるかを実測した(委譲ユースケースの中核6タスク、`total_cost_usd` ベース。全データと分析は [eval/REPORT.md](./eval/REPORT.md) の「委譲検証」節)。

- **固定費モデル(2段の損益分岐)**: 委譲は Claude 側に**タスク規模によらないほぼ固定のオーケストレーションコスト**を課す(組み込みシステムプロンプトのキャッシュ + 作業指示書 + 検証 + feedback 記録)。第5ラウンドでこの固定費を分解すると、**セッション起動費 S ≈ $0.10(委譲件数に非依存)+ 1件あたりの作業費 T ≈ $0.03** だった。したがって損益分岐は2段書きになる: **単発委譲は 1件 ≈ $0.11〜0.18(= S+T、フルセッション)で損益分岐 ≈ baseline $0.15**、**1セッションに複数束ねるバッチ委譲なら S が件数で割られて 1件 ≈ $0.06〜0.08(実測 $0.064)**。40ファイル規模の重量級タスクでもこの床帯は再確認された。
- **対照実験で確認(Haiku ワーカー)**: 委譲先を無料のローカル `lh` から課金される `claude --model haiku` に差し替えても、オーケストレータ側の床は lh 版 $0.81 vs Haiku 版 $0.91(+12%)とほぼ不変——**床は呼び出し元(Sonnet)側の構造費で、ローカルモデルの問題ではない**。その結果、安価な API ワーカーへ委譲すると床+ワーカー費で **課金合計は +16% の純損**になり、委譲が得になるのは**ワーカーの限界費用がゼロ(=ローカル)**のときだけと確定した。実時間ペナルティ 3.7倍のうち委譲構造分は ~1.5倍で、残りはローカル推論速度(ハードウェア)。
- **得なタスク(sweet spot)**: 多ターンの機械的作業。rename-sweep(12ファイル23箇所)は $0.337→$0.126 で **−63%**。第4ラウンドで足した重量級 API 移行(40ファイル46箇所)も baseline $0.23→委譲 $0.13 で **−44%**(両者 PASS)。ただし現実的な節約幅は **−30〜50%** が上限で、**−80% 級は出ない**。
- **損なタスク(anti-pattern)**: 数ターンで終わる小タスク。doc-sync(1分未満)は $0.081→$0.120 で **+49%**(委譲するとかえって高い)。
- **バッチ委譲で軽タスクも黒字化(第5ラウンド)**: 独立した委譲向きタスクが複数あるなら、別々に投げず**同一セッションでまとめて委譲する**。起動費 S が件数で償却され 1件あたり実効費が下がる。独立3件(docs / types / perf 級)を1セッションで委譲した batch-trio では、baseline $0.351 / 単発委譲3件合計 $0.397 に対し**バッチ $0.192(3/3 PASS)= 1件あたり $0.064**、単発 floor($0.132/件)比 **−51.6%**・baseline 比 −45.3%。単発では負ける doc-sync 級も、他の委譲と束ねれば黒字化する。
- **束ね方は一級 `lh batch` 一択(第6ラウンド)**: 上記バッチ償却を一級サブコマンド化して同日 3-way 比較(Claude Code 2.1.202・warm 統制)したところ、**「N 回の `lh -p` を手で並べる」手組み逐次委譲はフル ≈$0.60+ で baseline($0.446)比 +27% の赤字に転落**し、**1回の `lh batch` はフル ≈$0.39〜0.42 で −6〜13% の黒字を維持**(対手組み ≈−30%)。2.1.202 でシステムプレフィックスが ~3.3倍に肥大しオーケストレータの1ターンが高くなったため、ターン数を畳む一級コマンドの構造優位が旧会計より効く。加えてバッチはマニフェスト受理後の実行・check・修復・永続化がローカル側で完結するため、**呼び出し元がいつ死んでも委譲済みの仕事は完遂される**(実測で手組みは環境死により 1/3 委譲のまま FAIL、バッチは 2 run とも 3/3)。注意: ドル絶対額は CLI バージョンの会計に依存する(この行の数値は 2.1.202、上の行は 2.1.77)。ローカル壁時計は run 間分散が大きく(同一バッチで合計 333〜1688s の実測)、急ぎなら委譲自体を避ける。
- **意外な落とし穴 — スクリプト化できる機械的スイープ**: 規則が明文化でき、正解値をコメントやマニフェストから機械抽出できる類のスイープは、Claude 自身がスクリプト一発で畳めるため baseline が安く済む(40ファイルの一括変更でも $0.23 に収まった)。「ファイル数が多い=高い=委譲で大勝ち」は成り立たない。委譲する前に、まず「Claude がスクリプトを書く」選択肢とコストを比べること。委譲が明確に得なのは、スクリプトでは捉えられない per-file の判断が要るスイープに限られる。
- **品質リスク = 検証者の浅さ**: no-repro では、ローカルモデルは判断は正しかったが厳密な出力フォーマット(1行目の完全一致)を破り、Claude が意味だけ検証して誤って合格を記録 → FAIL。**`--check "<受け入れコマンド>"` を付け、`check.exit_code===0` と diff を確認してから `feedback pass` すること**が対策。
- **実時間トレードオフ**: 委譲アーム全体で壁時計 **約3.7〜4.1倍**(`--check` 実行分が上乗せ)、重量級の単一タスクでは **~7倍**(88s→599s)まで伸びた実測点もある。API コストを壁時計時間(約3〜7倍)と引き換える取引。
- **遵守率も設計対象**: 「必ず委譲せよ」というソフトな指示は6タスク中3タスクで無視された(損益分岐近傍では自力実行の方が合理的なので、無視自体は妥当)。「最初の `lh` 呼び出しが返る前にファイルを編集するな」という強い明示に変えると遵守は 3/3 に上がった。
- **委譲前に実績を見る(stats 事前チェック)**: 委譲判断の前に `lh stats --by-kind --json` を読み、投げようとしている種類(`--kind`)の `gate.status` が `"block"` なら委譲しない——自力実行するか、作業指示を具体化してから再挑戦する。graded < 3 はデータ不足。それ以降は生のpass率ではなく95% Wilson成功率下限が50%を割るとblockするため、小標本の偶然の全勝を過信しない。distill/scout/research にも同じ gate を適用する。
- **submit/wait は原則使わない**: headless(`-p`)の自動委譲では submit/wait による壁時計短縮は出ない。単一タスクは +33% の純損(第4ラウンド)、委譲向き A を投げて別作業 B を裏で進める本来の使い方でも B≪A のため net 壁時計は縮まなかった(第5ラウンド async-pair)。overlap 機構自体は動く(B を A の裏に隠せた)が、残る A を結局 `lh wait` でブロックする。async-pair でコストが −12% だったのは壁時計短縮ではなくキャッシュ会計の副作用(n=1、再現未検証)。価値があるのは人間が対話セッションで無関係な別作業を並行するときのみ。
- **`--check` 導入で品質退行が解消(最新)**: 受け入れコマンドを `--check` で委譲先に渡し `--kind` でタグ付けする運用に変えたところ、**−22% コスト・6/6 PASS**(第2ラウンドの偽 pass による品質退行がゼロに)を達成した。オーケストレーションの固定床は予測どおり不変($0.81→$0.82 横ばい)で、**`--check` が生むのはコスト減ではなく品質保証**である(受け入れゲートが委譲先のローカル検証に移り、Claude は `check.exit_code` を見るだけでよくなる)。
- **前処理は委譲と損益構造が違う**: `lh distill` / `lh scout` / `lh research` は作業を任せるのではなく、大きな入力、探索ファンアウト、複数Webページをローカルで処理し、引用付き digest だけを上位エージェントに返す。節約は固定床ではなく入力サイズ・探索ファイル数に比例し、削った文脈は残りターンでも再課金されない。citationのrecallは評価で測る必要があるため、digestだけで判断せずファイルrangeまたはWeb snapshotを読み直す。

| (6タスク計) | baseline (自力) | 委譲(`--check`・最新) |
|---|---|---|
| Claude コスト | $1.05 | $0.82(**−22%**) |
| PASS | 6/6 | **6/6** |
| Claude 壁時計 | 372s | 1525s(4.1倍) |

結論: 委譲は「大きく・機械的で・厳密に検証できる」タスクに絞れば得。小さいタスクや検証が甘いと、コスト増か品質退行を招く。

### CLAUDE.md / AGENTS.md 設定Tips

上位エージェントに委譲を使わせるときの、実測に基づく設定指針:

- **「常に委譲」ではなく「いつ委譲が得か」を書く**: コスト床(上記)を判断基準として渡す。ソフトな強制は約半分無視され、しかも損益分岐近傍ではその不遵守は経済的に合理的だった。**外せない強制表現(「最初の `lh` 呼び出しが返る前にどのファイルも編集しない」)は、コスト以外の理由(プライバシー/オフライン)で委譲が必須のときに取っておく**(実測で遵守が 3/3 に上がる)。
- **必ず入れる4点**: (1) `--check "<受け入れコマンド>"` と `check.exit_code===0` の確認、(2) `lh feedback` の記録を必須化、(3) Bash タイムアウト — ローカル実行は 1〜20 分かかるので **≥900000 ms**(submit/wait は headless では使わない=壁時計短縮が出ない)、(4) 委譲は壁時計時間(約3〜7倍)を API コストと引き換える取引だという注記。
- **委譲がたまったらバッチにさせる**: 固定費の大半はセッション起動費なので、独立した委譲向きタスクが複数あるなら **`lh batch --tasks -`(JSON マニフェスト、各タスクに id/kind/check)で1コールに束ねさせる**。手組みで `lh -p` を並べるより約3割安く、呼び出し元が途中で死んでも委譲済みタスクは完遂・永続化される。
- **委譲前に `lh advise` を使わせる**: size/risk/checkとcaller/model/hardwareを渡し、`recommended:false`または`direct`なら委譲しない。`lh stats --by-kind --model ... --hardware ... --caller ... --json`は理由の監査と再校正に使い、dimension-unknownを成功証拠へ混ぜない。

長い規約をREADMEへ二重管理せず、Claude Codeには [delegate-local skill](./integrations/claude-code/delegate-local/SKILL.md)、Codexには [AGENTS snippet](./integrations/codex/AGENTS-snippet.md) をそのまま導入する。インストールとdimension設定は [integrations/SETUP.md](./integrations/SETUP.md) を参照。

## 主な強化ポイント

- **ツールコール修復パイプライン**: 名前のエイリアス/編集距離マッチ、二重エンコードJSONのアンラップ、引数キーの正規化、型強制。失敗はリクエストエラーにせず、修正方法を具体的に書いたツール結果としてモデルに返す
- **edit の多段マッチングカスケード**: exact → Unicode正規化 → 行トリム → エスケープ正規化 → ブロックアンカー。弱いモデルの空白・引用符の揺れを吸収
- **テキストフォールバックパーサ**: ネイティブ tool_calls が出ないターンでも `<tool_call>` JSON ブロックを回収
- **ループ検出**: 同一コール連続で警告→強制停止、空ターン検出、切断応答時の edit/write 拒否
- **thinking ウォッチドッグ**: 出力開始前の thinking が予算(`--think-budget`、既定6000字)を超えたらそのターンを中断し、「最善の仮説を1-2文で述べ即座にツールで検証せよ」と促して再試行(2回目は thinking 無効化)。暴走した推論ブロックで壁時計時間を浪費するのを防ぐ
- **write ガードレール**: 既存30行以上のファイルへの全書き換えは `overwrite: true` が無いと拒否し edit を促す(読んだ上での全書き換えによるコード欠落を防止)。内容が完全一致する write はディスクに触れず no-op
- **段階的コンテキスト管理**: 実測トークン(prompt_eval_count)で校正した会計 → 75% で旧ツール出力をスタブ化 → 85% で構造化サマリへコンパクション(+機械的ファイルリスト)。ゲート判定の余裕は `--headroom`(既定4096)で予約(旧実装は num_predict 全量を足していたため早発していた)。Ollama のプレフィックス KV キャッシュを壊さない append-only 設計
- **todo の常時注入**: 変更時のみ末尾に再掲して 27B の脱線を防止

## テスト・評価

```sh
bun test                             # ユニットテスト
bun run eval/run.ts --agent harness  # 本ハーネス + ローカルモデルで評価タスク実行
bun run eval/run.ts --agent claude   # Claude Code (sonnet) ベースライン

# 複数armをseed付き順序で3反復し、run metadataを分離保存
bun run eval/run.ts --arms claude,claude-delegate --task doc-sync,fix-bug \
  --repeat 3 --run-id delegate-ci --order-seed 20260708
bun run eval:analyze -- --run-id delegate-ci
bun run eval:gate -- --run-id delegate-ci --max-quality-drop 0 \
  --min-cost-saving-usd 0 --max-p95-sec 1800
```

評価は fixture を一時ディレクトリへコピーして実行し、タスク付属のテストで自動判定する(テストファイル改ざんはハッシュ比較で検出)。`--arms`/`--repeat`は各sampleを別summary/log/LH_HOMEへ分離し、`--order-seed`でarm順を再現可能にする。metadataにはrepeat/seed/実順序/cold-warm、git commit+dirty、model digest/quantization、Ollama・caller CLI version、GPUを保存し、取得不能値は理由付き`null`にする。`eval:analyze`はmedian/p90/p95・品質・caller cost節約を集計し、`eval:gate`は品質非劣性・節約・candidate p95の欠損または閾値違反をnonzeroでfail-closedにする。結果は `eval/results/` に保存される。詳細は [eval/README.md](./eval/README.md)。

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
