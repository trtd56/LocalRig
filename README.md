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
| `--num-ctx N` | コンテキスト窓(env: `LH_NUM_CTX`、既定 32768。VRAM に余裕があれば `LH_NUM_CTX=65536` 推奨) |
| `--num-predict N` | 1ターンあたりの最大生成トークン(既定 16384) |
| `--temperature T` | 既定 0.6(Qwen3.6 thinking 推奨値) |
| `--presence-penalty P` | 反復抑制ペナルティ(env: `LH_PRESENCE_PENALTY`、既定 1.0。Qwen 公式の反復対策レバー) |
| `--max-iterations N` | エージェントループ上限(既定 60) |
| `--max-time SECONDS` | 実時間の予算。超過時はツール禁止のテキスト要約で打ち切り(status=`timeout`)。`0` で無効(env: `LH_MAX_TIME` 秒、既定 0) |
| `--think-budget CHARS` | 出力開始前の thinking がこの文字数を超えたらそのターンを中断・再試行(env: `LH_THINK_BUDGET`、既定 6000)。1ターンにつき最大2回まで、2回目は thinking を無効化して再試行 |
| `--headroom TOKENS` | prune/compact ゲート判定で現在推定に上乗せする予約トークン(次の応答用の余裕)。`num_predict` ではなくこれを使う(env: `LH_HEADROOM`、既定 4096) |
| `--auto` | 危険な bash コマンドのみ確認、他は自動承認(ワンショットでは確認できないため**拒否**になる。REPL では `/auto` でトグル) |
| `--yolo` | 全 mutating ツールを自動承認(ワンショットの既定) |
| `-v` | 詳細表示(ツール出力・トークン使用量) |

> **警告:** ワンショットモード(`-p`)は TTY が無く確認プロンプトを出せないため、`--auto` も `--yolo` も指定しないと**確認せず自動的に `--yolo`(全 mutating ツール自動承認)になる**。「権限確認が入る」わけではない。信頼できない/未知のリポジトリへ委譲するときは、上位エージェント側で必ず `--auto` を明示指定すること。

終了コード: `0` = 完了、`1` = 途中終了(ループ検出・上限到達・実時間超過・エラー)、`130` = 割り込み。

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

## 委譲は得か? 使い所とコスト

Claude Code から `lh` へ委譲して Claude 側の API コストが実際に下がるかを実測した(委譲ユースケースの中核6タスク、`total_cost_usd` ベース。全データと分析は [eval/REPORT.md](./eval/REPORT.md) の「委譲検証」節)。

- **固定費モデル**: 委譲は Claude 側に**タスク規模によらないほぼ固定のオーケストレーションコスト(約 $0.11〜0.15**: 組み込みシステムプロンプトのキャッシュ + 作業指示書 + 検証 + feedback 記録)を課す。節約が出るのは baseline コストがこの床を超えるタスクだけで、**損益分岐 ≈ baseline $0.15**。
- **得なタスク(sweet spot)**: 多ターンの機械的作業。rename-sweep(12ファイル23箇所)は $0.337→$0.126 で **−63%**。
- **損なタスク(anti-pattern)**: 数ターンで終わる小タスク。doc-sync(1分未満)は $0.081→$0.120 で **+49%**(委譲するとかえって高い)。
- **品質リスク = 検証者の浅さ**: no-repro では、ローカルモデルは判断は正しかったが厳密な出力フォーマット(1行目の完全一致)を破り、Claude が意味だけ検証して誤って合格を記録 → FAIL。**`feedback pass` の前に受け入れコマンドそのものを再実行すること**が対策。
- **実時間トレードオフ**: 委譲アーム全体で壁時計 **約3.7倍**。API コストを壁時計時間(約3〜7倍)と引き換える取引。
- **遵守率も設計対象**: 「必ず委譲せよ」というソフトな指示は6タスク中3タスクで無視された(損益分岐近傍では自力実行の方が合理的なので、無視自体は妥当)。「最初の `lh` 呼び出しが返る前にファイルを編集するな」という強い明示に変えると遵守は 3/3 に上がった。

| (6タスク計) | baseline (自力) | 委譲(強制) |
|---|---|---|
| Claude コスト | $1.05 | $0.81(**−23%**) |
| PASS | 6/6 | 5/6 |
| Claude 壁時計 | 372s | 1369s(3.7倍) |

結論: 委譲は「大きく・機械的で・厳密に検証できる」タスクに絞れば得。小さいタスクや検証が甘いと、コスト増か品質退行を招く。

### CLAUDE.md / AGENTS.md 設定Tips

上位エージェントに委譲を使わせるときの、実測に基づく設定指針:

- **「常に委譲」ではなく「いつ委譲が得か」を書く**: コスト床(上記)を判断基準として渡す。ソフトな強制は約半分無視され、しかも損益分岐近傍ではその不遵守は経済的に合理的だった。**外せない強制表現(「最初の `lh` 呼び出しが返る前にどのファイルも編集しない」)は、コスト以外の理由(プライバシー/オフライン)で委譲が必須のときに取っておく**(実測で遵守が 3/3 に上がる)。
- **必ず入れる4点**: (1) 厳密検証ルール — `feedback pass` の前にタスクの受け入れコマンドを実際に実行(意味確認だけで済ませない)、(2) `lh feedback` の記録を必須化、(3) Bash タイムアウト — ローカル実行は 1〜20 分かかり既定2分のツールタイムアウトでは lh が殺されるので **≥900000 ms かバックグラウンド実行**を指示、(4) 委譲は壁時計時間(約3〜7倍)を API コストと引き換える取引だという注記。

CLAUDE.md 用スニペット(コピペ可):

```text
ローカル委譲CLI `lh` が使える(delegate-local スキル)。多ターンで機械的、かつ厳密に検証可能なタスク(大規模リネーム・ボイラープレート・大きなテスト作成; 目安 baseline $0.15 超)のみ委譲する。小さいタスクは自分でやる方が安い(委譲は約$0.11〜0.15の固定オーバーヘッド)。実行: lh -p "<作業指示>" --json --cwd <絶対パス> --max-time 1200 を Bash タイムアウト 1500000 ms で。返答後は「タスクの受け入れコマンドを実際に実行して」検証し(厳密な出力フォーマット要件は逐語で確認)、lh feedback <session_id> pass|fail --source claude-code --notes "<理由>" を必ず記録する。委譲は壁時計を3〜7倍にする取引である点に注意。
```

AGENTS.md 用スニペット(コピペ可):

```text
ローカル委譲CLI `lh`(Qwen 3.6 27B / Ollama)が使える。多ターンで機械的、かつ厳密に検証可能なタスクのみ委譲する(委譲は約$0.11〜0.15の固定コストがあり、数ターンで終わるタスクは自分でやる方が安い; 損益分岐 baseline $0.15)。実行: lh -p "<file パスと合格コマンドを含む作業指示>" --json --cwd <絶対パス> --max-time 1200、Bash タイムアウトは ≥900000 ms かバックグラウンド。返答後は受け入れコマンドを実際に実行して検証し(意味確認だけにしない)、lh feedback <session_id> pass|fail --source codex --notes "<検証内容/失敗理由>" を必ず記録。委譲は壁時計を3〜7倍にする。詳細は integrations/codex/AGENTS-snippet.md。
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
