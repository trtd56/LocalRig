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
localrig -p "タスク" --json --check "bun test"  # 機械向け: JSON 1行を stdout に出力

# 既存連携向けに `lh` も同じCLIとして利用可能
lh -p "タスク"
lh submit -p "タスク" --json  # detached 実行
lh wait <session_id> --json   # detached 実行の完了待ち
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
| `--max-time SECONDS` | 実時間の予算。超過時はツール禁止のテキスト要約で打ち切り(status=`timeout`)。`0` で無効(env: `LH_MAX_TIME` 秒、既定 0) |
| `--think-budget CHARS` | 出力開始前の thinking がこの文字数を超えたらそのターンを中断・再試行(env: `LH_THINK_BUDGET`、既定 6000)。1ターンにつき最大2回まで、2回目は thinking を無効化して再試行 |
| `--headroom TOKENS` | prune/compact ゲート判定で現在推定に上乗せする予約トークン(次の応答用の余裕)。`num_predict` ではなくこれを使う(env: `LH_HEADROOM`、既定 4096) |
| `--check COMMAND` | ワンショット完了後に受け入れコマンドを実行。失敗時は出力末尾をモデルへ戻して自己修復を試みる |
| `--check-retries N` | `--check` 失敗後の修復試行回数(既定 2) |
| `--kind KIND` | 委譲種類タグ。推奨語彙: `rename`, `tests`, `docs`, `types`, `perf`, `bugfix`, `other` |
| `--resume ID` | 保存済みセッションの transcript を復元し、`-p` の指示を追撃として追記して再実行(ワンショット専用)。新 `session_id` を発行し `resumed_from` を記録。`--cwd` 未指定なら元セッションの cwd を継承。不明IDは `error_kind:"config"` |
| `--auto` | 危険な bash コマンドのみ確認、他は自動承認(ワンショットでは確認できないため**拒否**になる。REPL では `/auto` でトグル) |
| `--yolo` | 全 mutating ツールを自動承認(ワンショットの既定) |
| `-v` | 詳細表示(ツール出力・トークン使用量) |

> **警告:** ワンショットモード(`-p`)は TTY が無く確認プロンプトを出せないため、`--auto` も `--yolo` も指定しないと**確認せず自動的に `--yolo`(全 mutating ツール自動承認)になる**。「権限確認が入る」わけではない。信頼できない/未知のリポジトリへ委譲するときは、上位エージェント側で必ず `--auto` を明示指定すること。

終了コード: `0` = 完了、`1` = 途中終了(ループ検出・上限到達・実時間超過・エラー)、`130` = 割り込み。

## Claude Code / Codex からの委譲とフィードバック

上位エージェント(Claude Code / Codex)が簡単なタスクをローカル LLM に投げてトークンを節約するための仕組み。ワンショット実行は毎回 `~/.localrig/sessions/` にセッションとして記録され、呼び出し側が検証後に採点を返せる。

```sh
lh -p - --json --cwd /path/to/repo --kind bugfix --check "bun test test/foo.test.ts" <<'EOF'
src/foo.ts の null チェック漏れを修正。
完了条件: bun test test/foo.test.ts が通ること。
EOF
# → {"session_id":"...","status":"ok","check":{"exit_code":0,...},"report":{"changed_files":[...],"commands_run":[...]},...}

# 呼び出し側が report.changed_files と diff を確認したあと採点(必須のプロトコル):
lh feedback 20260703-141530-a1b2 pass --source claude-code --notes "tests pass"
lh feedback 20260703-141530-a1b2 fail --source claude-code --notes "別ファイルを編集していた"

lh sessions        # 最近のセッション一覧(採点状況つき)
lh stats           # 委譲の合格率と直近の失敗ノート(委譲判断の較正に使う)
lh stats --by-kind # kind ごとの件数・pass率・平均 duration
```

`--json` の `report.changed_files` は `write` / `edit` ツール経由の作成・更新のみを確実に記録する。`bash` 経由の `rm` / `mv` / 生成ファイルは網羅しないため、呼び出し側は `report.changed_files` を入口にしつつ、最終的な diff 確認は省略しないこと。`report.commands_run` はモデルが bash ツールで実行したコマンド列。

呼び出し元が**ローカル実行と無関係な別作業を並行で進めたい**ときは detached 実行を使える(単一タスクを submit→即 wait するだけなら、実効ブロック時間は同期 `lh -p` と変わらずターン増で +33% 高くつく。単一タスクは同期実行が正解):

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

`--resume` は元セッションの transcript を復元して追撃指示を追加実行し、**新しい** `session_id` を発行する(JSON とセッション記録に `resumed_from` が入る)。`--cwd` 未指定なら元セッションの cwd を継承。ワンショット専用(REPL・`lh submit` では使えない)で、不明IDは `error_kind:"config"` のエラーになる。`feedback fail` を付けたあとの差し戻しの標準手段で、再委譲1回分のプロンプト再構築を省ける。差し戻し後も新セッションを検証し、`feedback` を記録し直すこと。

エージェント側の設定はコピーするだけ(詳細な手順・権限設定・トラブルシューティングは [integrations/SETUP.md](./integrations/SETUP.md)):

- **Claude Code**: `cp -r integrations/claude-code/delegate-local ~/.claude/skills/` — 委譲基準・検証・フィードバック必須のプロトコルを定義したスキル
- **Codex**: `integrations/codex/AGENTS-snippet.md` の内容を `~/.codex/AGENTS.md` に追記

データ置き場は env `LH_HOME` で変更可能(既定 `~/.localrig`)。

## 委譲は得か? 使い所とコスト

Claude Code から `lh` へ委譲して Claude 側の API コストが実際に下がるかを実測した(委譲ユースケースの中核6タスク、`total_cost_usd` ベース。全データと分析は [eval/REPORT.md](./eval/REPORT.md) の「委譲検証」節)。

- **固定費モデル**: 委譲は Claude 側に**タスク規模によらないほぼ固定のオーケストレーションコスト(約 $0.11〜0.18**: 組み込みシステムプロンプトのキャッシュ + 作業指示書 + 検証 + feedback 記録)を課す。節約が出るのは baseline コストがこの床を超えるタスクだけで、**損益分岐 ≈ baseline $0.15**(40ファイル規模の重量級タスクでもこの床帯は再確認された)。
- **対照実験で確認(Haiku ワーカー)**: 委譲先を無料のローカル `lh` から課金される `claude --model haiku` に差し替えても、オーケストレータ側の床は lh 版 $0.81 vs Haiku 版 $0.91(+12%)とほぼ不変——**床は呼び出し元(Sonnet)側の構造費で、ローカルモデルの問題ではない**。その結果、安価な API ワーカーへ委譲すると床+ワーカー費で **課金合計は +16% の純損**になり、委譲が得になるのは**ワーカーの限界費用がゼロ(=ローカル)**のときだけと確定した。実時間ペナルティ 3.7倍のうち委譲構造分は ~1.5倍で、残りはローカル推論速度(ハードウェア)。
- **得なタスク(sweet spot)**: 多ターンの機械的作業。rename-sweep(12ファイル23箇所)は $0.337→$0.126 で **−63%**。第4ラウンドで足した重量級 API 移行(40ファイル46箇所)も baseline $0.23→委譲 $0.13 で **−44%**(両者 PASS)。ただし現実的な節約幅は **−30〜50%** が上限で、**−80% 級は出ない**。
- **損なタスク(anti-pattern)**: 数ターンで終わる小タスク。doc-sync(1分未満)は $0.081→$0.120 で **+49%**(委譲するとかえって高い)。
- **意外な落とし穴 — スクリプト化できる機械的スイープ**: 規則が明文化でき、正解値をコメントやマニフェストから機械抽出できる類のスイープは、Claude 自身がスクリプト一発で畳めるため baseline が安く済む(40ファイルの一括変更でも $0.23 に収まった)。「ファイル数が多い=高い=委譲で大勝ち」は成り立たない。委譲する前に、まず「Claude がスクリプトを書く」選択肢とコストを比べること。委譲が明確に得なのは、スクリプトでは捉えられない per-file の判断が要るスイープに限られる。
- **品質リスク = 検証者の浅さ**: no-repro では、ローカルモデルは判断は正しかったが厳密な出力フォーマット(1行目の完全一致)を破り、Claude が意味だけ検証して誤って合格を記録 → FAIL。**`--check "<受け入れコマンド>"` を付け、`check.exit_code===0` と diff を確認してから `feedback pass` すること**が対策。
- **実時間トレードオフ**: 委譲アーム全体で壁時計 **約3.7〜4.1倍**(`--check` 実行分が上乗せ)、重量級の単一タスクでは **~7倍**(88s→599s)まで伸びた実測点もある。API コストを壁時計時間(約3〜7倍)と引き換える取引。
- **遵守率も設計対象**: 「必ず委譲せよ」というソフトな指示は6タスク中3タスクで無視された(損益分岐近傍では自力実行の方が合理的なので、無視自体は妥当)。「最初の `lh` 呼び出しが返る前にファイルを編集するな」という強い明示に変えると遵守は 3/3 に上がった。
- **`--check` 導入で品質退行が解消(最新)**: 受け入れコマンドを `--check` で委譲先に渡し `--kind` でタグ付けする運用に変えたところ、**−22% コスト・6/6 PASS**(第2ラウンドの偽 pass による品質退行がゼロに)を達成した。オーケストレーションの固定床は予測どおり不変($0.81→$0.82 横ばい)で、**`--check` が生むのはコスト減ではなく品質保証**である(受け入れゲートが委譲先のローカル検証に移り、Claude は `check.exit_code` を見るだけでよくなる)。

| (6タスク計) | baseline (自力) | 委譲(`--check`・最新) |
|---|---|---|
| Claude コスト | $1.05 | $0.82(**−22%**) |
| PASS | 6/6 | **6/6** |
| Claude 壁時計 | 372s | 1525s(4.1倍) |

結論: 委譲は「大きく・機械的で・厳密に検証できる」タスクに絞れば得。小さいタスクや検証が甘いと、コスト増か品質退行を招く。

### CLAUDE.md / AGENTS.md 設定Tips

上位エージェントに委譲を使わせるときの、実測に基づく設定指針:

- **「常に委譲」ではなく「いつ委譲が得か」を書く**: コスト床(上記)を判断基準として渡す。ソフトな強制は約半分無視され、しかも損益分岐近傍ではその不遵守は経済的に合理的だった。**外せない強制表現(「最初の `lh` 呼び出しが返る前にどのファイルも編集しない」)は、コスト以外の理由(プライバシー/オフライン)で委譲が必須のときに取っておく**(実測で遵守が 3/3 に上がる)。
- **必ず入れる4点**: (1) `--check "<受け入れコマンド>"` と `check.exit_code===0` の確認、(2) `lh feedback` の記録を必須化、(3) Bash タイムアウト — ローカル実行は 1〜20 分かかるので **≥900000 ms**、または大きいタスクは `lh submit` → 別作業 → `lh wait`、(4) 委譲は壁時計時間(約3〜7倍)を API コストと引き換える取引だという注記。

CLAUDE.md 用スニペット(コピペ可):

```text
ローカル委譲CLI `lh` が使える(delegate-local スキル)。多ターンで機械的、かつ厳密に検証可能なタスク(大規模リネーム・ボイラープレート・大きなテスト作成; 目安 baseline $0.15 超)のみ委譲する。小さいタスクは自分でやる方が安い(委譲は約$0.11〜0.18の固定オーバーヘッド)。実行: heredoc で `lh -p - --json --cwd <絶対パス> --kind <種類> --check "<受け入れコマンド>" --max-time 1200` を Bash タイムアウト 1500000 ms で。返答後は `check.exit_code===0` と `report.changed_files`/diff を確認し、`lh feedback <session_id> pass|fail --source claude-code --notes "<理由>"` を必ず記録する。大きいタスクは `lh submit` → 別作業 → `lh wait` を使える。委譲は壁時計を3〜7倍にする取引である点に注意。
```

AGENTS.md 用スニペット(コピペ可):

```text
ローカル委譲CLI `lh`(Qwen 3.6 27B / Ollama)が使える。多ターンで機械的、かつ厳密に検証可能なタスクのみ委譲する(委譲は約$0.11〜0.18の固定コストがあり、数ターンで終わるタスクは自分でやる方が安い; 損益分岐 baseline $0.15)。実行: heredoc で `lh -p - --json --cwd <絶対パス> --kind <種類> --check "<受け入れコマンド>" --max-time 1200`、Bash タイムアウトは ≥900000 ms。返答後は `check.exit_code===0` と `report.changed_files`/diff を確認し、`lh feedback <session_id> pass|fail --source codex --notes "<検証内容/失敗理由>"` を必ず記録。大きいタスクは `lh submit` → 別作業 → `lh wait`。詳細は integrations/codex/AGENTS-snippet.md。
```

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
