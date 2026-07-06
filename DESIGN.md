# LocalRig 設計ドキュメント

Qwen 3.6 27B (MTP, Ollama) 向けコーディングエージェントハーネス。
目標: Claude Code (Sonnet) と同等のコーディングタスク遂行能力。

## 前提・実測値

- モデル: `qwen36-27b-mtp:latest` (arch qwen35, 27.3B, Q4_K_S, 16GB)
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
- **実時間予算**: `--max-time SECONDS`(`LH_MAX_TIME`、既定0=無効)。各イテレーション冒頭で超過を検知したら max-iterations と同じ graceful wrap-up(ツール禁止・`think:false` のテキスト要約)へ移行し status=`timeout` で終了(終了コードは max_iterations 同様1)。eval runner はこれを1500秒で渡し、30分 SIGKILL をバックストップ化
- 割り込み(Ctrl+C)、one-shotモード(`-p`)とREPLモード。ウォッチドッグ中断はユーザ割り込みと区別(ユーザ Ctrl+C のみ status=`interrupted`)
- 許可モデル: デフォルトは write/edit/bash を確認、`--auto` は危険な bash コマンドのみ確認(denylist は permissions.ts)、`--yolo` で全自動承認

## モジュール構成

```
src/
├── index.ts          # CLIエントリ(REPL / -p one-shot)
├── agent.ts          # エージェントループ(コア)
├── config.ts         # 設定(model, num_ctx, temperature, limits, permissionMode)
├── permissions.ts    # 許可モード判定(auto用の危険コマンドdenylist)
├── provider/ollama.ts    # Ollama chat APIクライアント(stream, tools, thinking, token実測)
├── prompt/system.ts      # システムプロンプト生成(環境情報埋め込み)
├── tools/
│   ├── types.ts      # ToolDef, ToolResult型
│   ├── registry.ts   # 登録・ディスパッチ
│   ├── read.ts write.ts edit.ts bash.ts grep.ts glob.ts todo.ts
├── toolcall/
│   ├── validate.ts   # スキーマ検証・型強制・名前ファジーマッチ・修復メッセージ生成
│   └── loopdetect.ts # 反復検出
├── context/
│   ├── tokens.ts     # トークン会計(実測校正付き推定)
│   ├── prune.ts      # 古いツール結果のスタブ化
│   └── compact.ts    # 構造化サマリによる再構築
└── ui/render.ts      # ターミナル表示(ストリーム、色、diff表示)

eval/
├── tasks/            # 評価タスク(テスト付き)
├── run.ts            # ハーネスでタスク実行 → テストで検証
└── REPORT.md         # Claude Code出力との比較結果
```

## 調査で確定した設計根拠(pi / OpenCode / qwen-code)

| 項目 | 採用値 | 出典 |
|---|---|---|
| read上限 | 2000行 / 1行2000chars、続きはoffset指定(実用的フッター付き) | pi/OpenCode/qwen-code 全一致 |
| bash上限 | 30k chars、head+tail保持、**全出力をtempファイルにスプール**しパスを提示 | pi/OpenCode/qwen-code |
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

## 評価方法

各タスクを (1) 本ハーネス+Qwen3.6 (2) Claude Code で実行し、
自動テスト通過率・修正要否・イテレーション数を比較して REPORT.md に記録。

タスク例:
1. 単機能実装: 仕様からモジュール+テストを書く
2. バグ修正: 既存コードのテスト失敗を直す
3. マルチファイルリファクタ: 既存小規模プロジェクトの構造変更
