# distill_plan.md — 前処理レイヤー実装計画(P0 `lh distill` / P1 `lh scout` / P2 統合深化)

最終更新: 2026-07-08。委譲(検証可能なコーディング作業)に続く第2のユースケース——**Claude/Codex のコンテキストに投入する前の情報を、ローカル LLM で前処理・圧縮・選別するレイヤー**——の実装計画。本ファイルは後日のセッションが単独で実行できる形で記す。**実行順序のゲート: P1 は P0-4 の実測が黒字(または原因分解済みの見込み黒字)を示してから、P2 は P0/P1 の kind 別 feedback データが溜まってから着手する。**

## なぜやるか(委譲の実測事実からの導出)

- 委譲の節約は呼び出し元の固定 floor(S+T 構造)に律速され −30〜50% が天井(fix_plan.md 前提節)。前処理は構造が違う: **節約が入力サイズに比例する**(生 N トークンを Claude が読む代わりにローカルが読み、抽出 M トークンだけ返す。床は Bash 1 コール分)。
- Claude Code 2.1.202 の新会計(ターン毎の文脈税増)は委譲を圧迫したが前処理には**追い風**: コンテキストに入れた情報は残り全ターンで再課金されるため、圧縮の価値は「削減トークン × 残ターン数」の乗数付き。
- 「委譲 vs スクリプト化」の天井(第4R)は前処理にも適用される。**grep/jq/head で選別できる情報はスクリプトで足りる**。ローカル LLM の出番は意味的な選別のみ: ログのトリアージ(どの failure が根本原因か)、関連度選別(この質問に効く箇所はどれか)、横断的 QA。
- 委譲成功の決定打は `--check` = 受け入れゲートをローカルの機械検証に移したこと(第3R でゼロ品質退行)。no-repro の教訓「Claude の検証は受け入れゲートより浅い」は要約タスクで悪化する(要約の正しさは Claude に検証できない)。→ **出力を抽象(パラフレーズ)でなく抽出(引用+座標)に強制し、引用をハーネスが機械照合する**のが本設計の核。幻覚された根拠は構造的に Claude に届かない。

# P0: `lh distill` — 観点付きの抽出・圧縮

## 設計方針(v1 で確定させる決定)

1. **エージェントループなし**。入力ファイルはハーネスが読む(モデルにツールは渡さない)。単発〜少数回の completion で完結。委譲の実時間ペナルティ(3.7〜6.8 倍)の主因だった多ターン往復を構造的に持たない。
2. **出力契約は citation 付き JSON**(下記スキーマ)。Ollama の `format`(JSON schema 指定)で構造を強制し、プロンプト頼みにしない。
3. **citation はハーネスが機械照合**: quote が当該ファイルの当該行に実在するか突合。行ズレは近傍±20行→ファイル全体の順で探索して座標を修正、quote 自体が見つからないものは **drop してカウントを出力に明示**。precision は構成上 100% になる(recall は eval で計測するしかない——これが本機能の最重要リスク)。
4. **消費側の規約**(SKILL.md に明記): digest は「地図」であり真実ではない。編集する箇所は cited range を Read してから触る。`not_found: true` は「情報が無い」の正直な報告として尊重する(no-repro と同型の迎合バイアス検査を eval に含める)。
5. セッション・feedback・stats は既存機構をそのまま使う(kind 既定 `distill`)。graded≥3 かつ rate<50 なら使わない、の事前チェックゲートに自動で乗る。

### CLI 仕様

```
lh distill -q "<何を知りたいか>" [files...] [flags]
cat big.log | lh distill -q "..."            # stdin(ファイル引数なしのとき)
bun test 2>&1 | lh distill -q "落ちたテストの根本原因は?"
```

- `-q/--query`(必須): 抽出の観点。無指定は error_kind:config で拒否(観点なしの「要約」は recall 事故の温床なので v1 では作らない)。
- 入力: ファイル引数(glob はシェル展開に任せる)または stdin。併用時は stdin を `(stdin)` という擬似ファイルとして末尾に足す。バイナリ/巨大単一行はエラーでなく警告+スキップ。
- 既存フラグを流用: `--json`(session_id/status/tokens/feedback_command のラッパ。stdout の本文は digest JSON)、`--cwd`、`--max-time`、`--model`、`--kind`(既定 "distill")、`--quiet`、`-v`。
- 新フラグ: `--budget <tokens>`(digest 出力の目標上限、既定 2000。num_predict に反映)、`--think`(既定 off。単発抽出は非思考で速度優先、精度が足りない場合の opt-in。効果は P0-4 で実測)。
- exit code: 0=ok(citation 全 drop でも answer があれば 0。drop 数は JSON に出す)/1=error/130=割込。既存ワンショットと同じ。

### digest JSON スキーマ(stdout 本文)

```json
{
  "answer": "リトライ処理は HttpClient.withRetry に集約されている。...",
  "not_found": false,
  "citations": [
    {"file": "src/http/client.ts", "start_line": 142, "end_line": 158, "quote": "async withRetry("}
  ],
  "omitted": ["chunk 3/5 は予算超過で走査が浅い"],
  "citations_dropped": 0
}
```

- `quote` は先頭行の照合キー(短くてよい)。`answer` 内の主張はできる限り citation を伴うようプロンプトで強制。
- `not_found` は「該当情報なし」の一級の正直な回答。`citations_dropped` はハーネスが照合後に付与。

### チャンク処理(map-reduce)

- 予算 = num_ctx − system − query − 応答ヘッドルーム。既存の実測校正トークン推定(src/context/)を流用。
- 超過時: ファイル境界優先で分割、単一ファイル超過は行ベース分割(行番号は元ファイル基準を維持)。チャンク毎に同一スキーマで抽出(map)→ 全チャンクの citations+partial answers だけを入力に最終統合(reduce)。reduce 入力がなお超過なら citation を保ったまま answer 部を切り詰め、`omitted` に明記。**v1 は逐次実行**(Ollama 単一インスタンスでは並列の意味がない)、再帰 reduce なし(2 段まで)。
- system prompt はバッチ第6R の教訓どおり**1回構築して全チャンクで再利用**(prefix KV キャッシュ保護)。チャンク間で共有 prefix(system+query)を固定し、可変部(チャンク本文)だけ差し替える。

## 作業項目

### P0-0: プリフィル tok/s の実測(実装前・30分)

チャンクサイズと実用性の前提数値。10k/50k/100k トークン相当のプロンプトを /api/chat(stream)に投げ、初トークンまでの時間と eval_count/duration を記録。fix_plan 課題2(ローカル壁時計の分散)と同じ計測なので run 毎の tok/s 記録形式をここで決めて両課題で共用する。**10万トークンのプリフィルが数分オーダーなら map チャンクを小さくし、`--max-time` 既定の妥当性を見直す**。結果は DESIGN.md に追記。

### P0-1: `src/distill.ts` 純粋コア + テスト

バッチ(src/batch.ts)と同じ構成方針: I/O・モデル呼び出しは注入、コアは純粋関数でモデル不要テスト。

- `planChunks(files, tokenBudget, estimator)`: ファイル境界優先→行分割。元ファイル行番号の保持。
- `parseDigest(text)`: JSON 抽出+スキーマ検証。失敗時は修復リトライ用のエラー情報を返す(リトライは1回、`format` 指定があるので保険)。
- `verifyCitations(citations, readFile)`: 完全一致→±20行探索→全体探索の順で座標修正、不一致 drop。戻り値に verified/dropped。
- `mergeDigests(parts)`: citations 連結+同一 span dedupe、answer 統合入力の組み立て。
- `distill(deps)`: オーケストレータ。deps = { complete, readFile, estimator, now } を注入。
- テスト目安 30 件前後(チャンク境界・行番号保持・照合の3段探索・幻覚 drop・not_found 経路・修復リトライ・予算切り詰め)。

### P0-2: provider 拡張

- `ChatRequestOptions` に `format?: unknown`(Ollama の JSON schema 指定)を追加、`OllamaClient.complete()` がそれと `think` 明示指定を透過するように(現状 think:false ハードコード)。既存呼び出し(compaction)の挙動は不変に保つ。
- complete() は stream:false なので Bun の300秒アイドル問題の対象(既存コメントの通り `timeout: false` 済みであることを確認。未対応なら同修正)。**プリフィル+生成で300秒を超える巨大チャンクは正常系**なので必ず確認する。

### P0-3: CLI 配線 `cmdDistill` + セッション記録 + テスト

- `src/index.ts` に `case "distill"` を追加(parseArgs は既存を拡張: `-q/--query`/`--budget`/`--think`)。
- SessionRecord をそのまま使う: prompt=query、result=digest JSON 文字列、kind 既定 "distill"、status は既存 RunStatus の "ok"/"timeout"/"error"/"interrupted" のみ使用(**型の変更なし**)。tokens は全 completion 合算。`feedback_command` も従来どおり出す(消費側が digest の有用性を pass/fail で採点→ stats --by-kind に蓄積)。
- `--resume`/`submit` は distill では拒否(ワンショット専用。submit/wait は headless 不成立が確定済み)。
- テスト: BatchDeps 方式の DI で fake complete を注入し、stdin/ファイル入力・JSON ラッパ・セッション保存・budget 反映・タイムアウトを CLI 層で検証。dead port での error_kind:connection 経路も既存パターンで。

### P0-4: eval fixture + `claude-distill` アーム + 実測

fixture 2本(三重検証プロトコル準拠。ただし verify の観点が委譲系と違い「digest の質」なので下記のとおり機械判定に落とす):

1. **`distill-log-triage`**: 数千行のテスト/ビルドログ(planted: 根本原因1件+それに誘発された二次 failure 2件+大量のノイズ)。合格 = digest の citations が根本原因行を含む(grep 機械判定)。ローカル単体の recall 検査と、claude アームの素材を兼ねる。
2. **`distill-recall-needle`**: 大きめファイル群に planted fact を K=5 埋設し、query に対応する事実の引用再現率を機械採点。うち1問は**答えが存在しない query**(not_found を正直に返せるか= no-repro の distill 版。最重要)。

eval/run.ts に `claude-distill` アーム追加(DISTILL_NUDGE: 「N行を超えるログ/ファイル内容を直接読む前に `lh distill -q` を通すこと」)。**baseline(生読み)との2アーム同時比較、同日・同 CLI バージョン・warm 統制**(第6R プロトコル)。計測: PASS/コスト/壁時計/digest の recall。nudge 遵守が headless で守られない既知の故障モード(第1回委譲検証で 3/6)に注意——遵守しなかった run はアーカイブして再実行でなく**遵守率自体を結果として記録**する。

受け入れ条件(P0 全体):

- citation precision: 機械照合により構成上 100%(dropped は JSON で可視)。
- recall: needle fixture で 4/5 以上、not_found 問を正直に回答。
- claude-distill アーム: log-triage で PASS を維持しつつ baseline よりコスト減(入力比例仮説の実証。減らなければ「digest 出力が大きすぎる/nudge で余計なターンが増えた」を分解して原因を REPORT に記録)。
- bun test 全通過(既存 292+新規)、tsc clean。

### P0-5: ドキュメント同期

- SKILL.md(原本+インストール版 cp 同期)に「Preprocessing with lh distill」節: 使い所(数千行超のログ/ファイル・意味的選別が必要なときのみ。grep で足りるなら grep)、消費規約(地図であって真実ではない・編集前に cited range を Read・feedback 記録)、stats ゲート適用。
- integrations/codex/AGENTS-snippet.md に対応 Rule 追加。README「使い所」に前処理の損益構造(入力比例・floor なし)を追記。
- eval/REPORT.md に「前処理検証 第1ラウンド」節。メモリ(localllm-harness-project.md)と blog_draft.md を更新。
- 本ファイルの完了項目を削除(fix_plan.md と同じ運用)。

## やらないこと(v1)

- 観点なしの汎用要約(`-q` 必須)。recall 事故が検証不能なまま増えるだけ。
- distill へのエージェントループ/ツール付与(それは P1 scout の領分)。
- map チャンクの並列実行(Ollama 単一インスタンスでは無意味。複数インスタンス運用になったら再訪)。
- submit/wait 対応(headless 不成立が第5R で確定済み)。
- 抽象要約のみで citation を欠く出力モード(本設計の核を外すため恒久的に作らない)。

# P1: `lh scout` — 読み取り専用の探索エージェント

**着手ゲート: P0-4 で distill の黒字(または原因分解済みの見込み黒字)を確認してから。**

進捗メモ(2026-07-08): P1-1/P1-2 の実装、P1-3 の `claude-scout` アームと scout fixture 2本、P1-4 の主要ドキュメント同期は完了。scout digest の `not_found` / `citations_dropped` / citation recall は eval summary に保存され、fixture は `src/` 不変性も sha256 で検証する。素の `lh scout` は明示指定がなければ `max_iterations=20` / `max_time=900s`。`bun test test/` 333/333 PASS、`bunx tsc --noEmit` clean。P1-0 の実モデル smoke と P1-3 の同日実測(`claude` vs `claude-scout`、thinking on/off、citation recall/drop 集計)は未実施なので、P1 全体の損益分岐はまだ未確定。

## 位置づけと経済仮説

distill は「どこを読むかを呼び出し元が知っている」場合の圧縮。scout は「**どこを読むべきかをローカルが自分で探す**」——Claude 側の Explore ファンアウト(自力で grep→複数ファイル Read)の代替。節約仮説は distill と同じく入力比例(Claude が読むはずだった多数ファイルの input トークンを消す)だが、**多ターンのローカル・エージェントループが戻ってくるため、委譲で実測した実時間ペナルティ(3.7〜6.8倍)と壁時計分散(±2倍)がそのまま再発するリスクを負う**。scout が勝てるのは「Claude なら5ファイル以上読む質問」だけ、という予想を P1-3 で検証する。

## 設計方針

1. **既存 Agent の再利用+ツールセット注入**。現状 Agent はコンストラクタで `createTools(config, ctx)` を直呼びしている(src/agent.ts:82)ため、省略可能な `tools?: ToolDef[]` 引数を追加(未指定なら従来どおり全ツール=既存挙動不変)。registry に `createScoutTools(config)` = **read / grep / glob の3つのみ**を追加。bash なし(変異と副作用の経路を構造的に断つ——`--worktree` を不要にした発想と同じで、書けないエージェントに保護は要らない)。write/edit/todo なし(todo は有界の質問応答には計画ノイズ。必要性が出たら再訪)。
2. **system prompt は scout 専用を1回構築して注入**(batch で入れた `systemPrompt` 引数を流用)。内容: 質問に digest JSON 契約(P0 と同一スキーマ)で答える・主張には file:line citation・grep→絞り込み→read の探索手順・**推測で埋めず、見つからなければ not_found**。
3. **最終回答の JSON 強制はプロンプト+修復リトライ**(v1)。ツールループ中の chat() に Ollama `format` を掛けるとツールコール応答まで制約されるため使えない。ループ終了後に `parseDigest`(P0-1 の流用)で検証し、失敗したら「最終回答を JSON で再提出せよ」の修復ターンを1回だけ。それでも壊れていれば status は "ok" のまま `parse_failed: true` を JSON ラッパに立てて生テキストを返す(呼び出し元が読める形は保つ)。※代替案=ループ後に complete()+`format` で transcript から回答を再直列化する2段方式は、1ターン追加のコストが掛かるため v1 では見送り、修復リトライの失敗率が実測で高ければ再訪。
4. **citation はハーネスが機械照合**(P0-1 の `verifyCitations` をそのまま cwd 相対で流用)。scout は自分でファイルを読んでいるぶん distill より座標の信頼度は高いはずだが、照合を省かない(27B の行番号転記ミスは既知のリスク)。
5. **ループ予算は委譲より絞る**。scout は「答える」だけで「作る」工程がないので、`--max-iterations`・`--max-time` の scout 既定は一段小さくする(数値は P1-0 のスモークで決定し config に scout 用既定として置く。委譲側の既定は変更しない)。thinking は既定オン(探索の質に効く見込み)だが watchdog はそのまま効かせ、P1-3 で off と比較。
6. セッション・feedback・stats は既存機構(kind 既定 `scout`)。`--resume` は v1 拒否(復元時にツールプロファイルの復元が必要になる。セッションへの toolProfile 記録ごと P2 以降の宿題)。submit/wait も拒否(確定済み方針)。

### CLI 仕様

```
lh scout -q "リトライ処理はどこに実装されていて、呼び出し元は何箇所?" [--paths src/ lib/] [flags]
```

- `-q/--query` 必須(distill と同じ理由)。
- `--paths`(任意): 探索範囲のヒント。system prompt に載せるだけで強制はしない(グロブ強制は tools 側の改修が要るため v1 では見送り)。
- 流用フラグ: `--json` / `--cwd` / `--max-time` / `--max-iterations` / `--model` / `--kind`(既定 "scout")/ `--quiet` / `-v` / `--think`(P0-2 の透過を流用、既定オン)。
- stdout 本文は digest JSON(P0 と同一スキーマ+`turns` フィールド追加)。exit code 規約は distill と同じ。

## 作業項目

### P1-0: スモークと既定値の決定(実装前・1時間)

手元の実リポジトリ(本リポジトリで可)に対する探索質問 3〜5 本を、現行 `lh -p`(全ツール)+「編集禁止・citation 付き回答」プロンプトで流して挙動観察。決めること: (a) scout 既定の max_iterations / max_time(観察したターン数分布から)、(b) 27B が grep/glob をどの程度使いこなすか(使えないなら system prompt の探索手順記述を厚くする)、(c) thinking on/off の差の初期感触。結果は本ファイルに追記。

### P1-1: Agent ツールセット注入 + `createScoutTools` + テスト

- `Agent` コンストラクタに `tools?: ToolDef[]` 追加(既定=従来の `createTools`。**既存の全呼び出し元は無変更で挙動不変**をテストで固定)。
- `registry.ts` に `createScoutTools(config)`(read/grep/glob)。
- `src/prompt/system.ts` に scout 用ビルダー `buildScoutSystemPrompt(cwd, config, query, paths?)`(既存 `buildSystemPrompt` とは別関数。dirSnapshot 等の流用部品は共有)。
- テスト: ツール注入の既定不変・scout セットに write/edit/bash が含まれない・system prompt に探索手順と not_found 規約が載る。目安 10 件。

### P1-2: `cmdScout` CLI 配線 + 最終回答パース + テスト

- `src/index.ts` に `case "scout"`。Agent を scoutTools+scout systemPrompt で起動し、run 完了後に `parseDigest`→修復ターン→`verifyCitations`→JSON ラッパ出力→セッション保存。
- askPermission には**常時 deny を注入**(read/grep/glob は許可を要求しないはずだが、万一の経路への防波堤。deny で困る正当ケースは存在しない)。
- `--resume`/`submit` の拒否、`--paths` の system prompt 反映。
- テスト: fake Agent 注入(BatchDeps 方式)で JSON 修復経路・parse_failed 経路・citation drop・deny 防波堤・セッション保存。目安 15 件。

### P1-3: eval fixture + `claude-scout` アーム + 実測

fixture 2本+既存資産の流用:

1. **`scout-locate`**: 30 ファイル級リポジトリに「答えが 2〜3 ファイルに分散する質問」(例: 機能 X の定義・登録・呼び出し箇所)。合格 = citations が正解 file:line 集合を被覆(grep 機械判定、部分被覆は recall 値で記録)。
2. **`scout-honest`**: リポジトリに存在しない機能についての質問 → `not_found: true` を正直に返すか(迎合検査の scout 版。**推測でそれらしい citation を捏造しないか**が焦点——citation 照合が捏造を drop するので、機械判定は「dropped>0 かつ not_found=false」を FAIL とする)。
3. 既存 `large-codebase` fixture(36 ファイル・3層下の根本原因)を scout の題材に流用: 修正までさせず「根本原因の所在を citation 付きで特定せよ」という scout 質問に読み替えて再利用できるか確認、できれば fixture 追加を1本節約。

eval/run.ts に `claude-scout` アーム(SCOUT_NUDGE: 「リポジトリ横断の所在調査は自力 grep/Read の前に `lh scout -q` を使うこと」)。baseline との 2 アーム同日・同バージョン・warm 統制。計測: PASS / コスト / 壁時計 / citation recall / nudge 遵守率 / thinking on-off 差(同一 fixture で両設定を回す)。

受け入れ条件(P1 全体):

- scout-locate: citation recall ≥ 正解集合の 2/3、捏造 citation(dropped)ゼロ。
- scout-honest: not_found を正直に返す(最重要)。
- claude-scout アーム: 「Claude が5ファイル以上読む質問」でコスト減を確認。**減らない場合も「何ファイル読む質問から黒字か」の損益分岐を REPORT に記録できれば P1 は成果として成立**(scout の使い所を数値で画定することが目的であり、全面採用が目的ではない)。
- 既存テスト全通過(ツール注入の既定不変が最重要)+ tsc clean。

### P1-4: ドキュメント同期

P0-5 と同一手順(SKILL.md 原本+インストール版 / AGENTS-snippet / README / REPORT / メモリ / blog_draft)。SKILL.md には distill との使い分け(**読む場所が分かっている→distill、探す所から→scout、grep で足りる→スクリプト**)を三択表で明記。

## やらないこと(P1 v1)

- bash / write / edit / todo の付与(書けないエージェントに保護は要らない、を設計原則として維持)。
- `--paths` のツールレベル強制(プロンプトヒントのみ)。
- `--resume` / submit/wait 対応。
- ループ後 complete()+format での回答再直列化(修復リトライの失敗率が高いと実測されたら再訪)。

---

# P2: 統合深化 — 発火条件の数値化と自動化

**着手ゲート: P0/P1 の実測完了+kind 別 feedback(distill/scout)が graded≥10 程度溜まってから。** P2 は新機能でなく「いつ使うかの判断を、実測データで規則に落とす」フェーズ。項目は独立に実行可能。

進捗メモ(2026-07-08): P2 の足場として、`lh stats --by-kind --json` に kind 別 `gate.status` を追加(graded≥3 かつ pass rate<50 で block)、docs/skills/snippet に暫定発火条件を同期(distill=1000行または64KB以上の意味的選別、scout=5ファイル以上読む見込み)、eval runner に `--run-id`、`eval/analyze-preprocess.ts`、Claude Code PreToolUse 用の巨大 Read advisory hook を追加。P0/P1 の同日 n=3 実測、distill fixture/`claude-distill` アーム、stats ゲートの実効性測定は未実施なので、P2 の数値はまだ暫定。

## P2-1: 発火条件の数値化(nudge の規則化)

P0-4/P1-3 の実測から閾値を導出し、SKILL.md / AGENTS-snippet の規則を「〜のときに使え」から**数値条件**に置き換える:

- distill: 「N 行(または M KB)を超えるログ/ファイルは直接 Read せず distill を通す」の N/M を、損益分岐実測(digest 出力サイズ+呼び出しオーバーヘッド vs 生読みコスト)から決める。
- scout: 「予想読了ファイル数 ≥ K の所在調査は scout」の K を P1-3 の損益分岐から決める。
- 委譲で確立した stats 事前チェック(graded≥3 かつ rate<50 なら使わない)を distill/scout の kind にも明記適用。
- headless での規則遵守率を再測定(委譲第1回の 3/6 問題の再確認。遵守率が低ければ規則の文言を締める——委譲で「編集禁止の明文化」が 3/3 に上げた前例に倣う)。

## P2-2: stats ゲートの実効性測定(fix_plan 宿題の合流)

fix_plan.md 前提節の宿題「stats ゲートの効果の定量測定は fail 過半の kind が実データにたまってから」を、distill/scout の kind が増えてデータが溜まりやすくなった時点で合流実行。fail 過半の kind を意図的に作る fixture(27B に構造的に不得手なタスク)で、ゲートあり/なしの委譲・前処理判断を比較。

## P2-3: 自動化の調査(go/no-go 判断、コミットではない)

nudge(プロンプト規則)より強い自動化が割に合うかの調査のみ:

- **Claude Code hook 案**: PreToolUse hook で巨大ファイルへの Read を検知し「distill を検討せよ」を注入する設定スニペットを integrations/claude-code/ に置けるか。判断材料: 誤発火率(小さいファイルの連続 Read や、cited range の precise Read まで妨げないか)と、hook 注入がターン数・文脈税を逆に増やさないか。
- **判断: 誤発火が実用水準でなければ「やらないこと」に確定させて終了**(調査自体が成果。submit/wait と同じ扱い)。

## P2-4: 見出し数値の n=3 と公開物の統合

fix_plan 課題4(委譲の n=3)と同一プロトコル(**同日・同 CLI バージョン・warm 統制・中央値報告・version 記録**)で、前処理の見出しセル——distill-log-triage の baseline/claude-distill、scout-locate の baseline/claude-scout——を 3 回ずつ。完了後、REPORT.md に「前処理検証」章を委譲検証と対等の章として整理し、blog_draft を「委譲+前処理」の二本柱構成に改訂。

## 完了時の後処理

fix_plan.md「完了時の後処理」と同一(REPORT 追記→スキル/スニペット/README 同期→メモリ・blog 更新→本ファイルから完了課題を削除)。
