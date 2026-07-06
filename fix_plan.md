# fix_plan.md — 委譲先(サブエージェント)特化の改良計画

作成: 2026-07-06。委譲検証実験(eval/REPORT.md「委譲検証」節、コミット e1bb823)の実測結果に基づく改良計画。このファイル単独で実行可能なように背景から記載する。

## 背景: 実測で特定された3つの弱点

Claude Code → `lh` 委譲の実測(委譲6タスク、baseline vs 委譲アーム、詳細は eval/REPORT.md と eval/results/delegation-comparison.md)で判明:

1. **検証者の浅さ(品質リスクの実体)**: no-repro タスクでローカル Qwen は判断は正しかったが「1行目は完全一致で `verdict: not-reproducible`」という形式要件を破り、呼び出し元 Claude は意味内容だけ検証して偽 `pass` を記録 → verify FAIL。委譲による唯一の品質退行(6/6→5/6)はローカルモデルの能力不足ではなく**受け入れゲートより浅い検証**が原因。
2. **呼び出し元のオーケストレーション可変費**: 委譲時の Claude コストは $0.107〜0.154 にほぼ固定。内訳の大半(~$0.07〜0.10)は Claude Code 自身のセッション起動費(キャッシュ書込+読出)で**lh 側からは削れない**が、検証・feedback 記録のターン(1タスク $0.02〜0.05 程度)は削減余地がある。損益分岐は baseline ≈ $0.15。
3. **実時間ペナルティ**: 委譲タスクで壁時計 3.6〜6.6 倍(rename-sweep 90s→595s)。ローカル推論速度が原因で lh 側では速くできないが、呼び出し元の**待ち時間のブロック**は解消できる。

改良はこの3点に対応する。**注意: floor(損益分岐 ≈ $0.15)自体は呼び出し元側の固定費なので、以下の改良では大きく動かない。** 効果が出るのは「偽passによる手戻り防止」「検証ターン削減」「待ち時間の回収」。

---

## P0-1: `--check` 自己検証 + 自己修復ループ

> **✅ 実装済み(2026-07-06、ユーザーによる手動実装)。** 第3ラウンド実測: no-repro が **FAIL→PASS に回復**、委譲6タスク全てで `--check` を使用し全て exit 0・attempts 1(修復ループは未発火——受け入れゲートが「作業指示に埋めた `--check` + ローカル機械検証」へ移り、第2ラウンドの偽 pass 経路が構造的に消滅した)。オーケストレーターコストは横ばい($0.8125→$0.8165)で、これは本節冒頭の「floor は動かない」予測どおり。詳細は eval/REPORT.md「第3ラウンド」。

**目的**: 弱点1と2を同時に潰す。受け入れコマンドを lh 自身が実行し、失敗ならローカルモデル(限界費用ゼロ)で修復してから返す。呼び出し元は `check.exit_code` を見るだけでよい。

**仕様**:
```bash
lh -p "<作業指示>" --json --check "bash test/verify.sh" [--check-retries 2]
```
- エージェントループ完了後に `--check` のコマンドを cwd で実行(タイムアウトは bashTimeoutMs と同じ既定)。
- exit ≠ 0 なら「check が失敗した。出力: <末尾>。修正せよ」という user メッセージを注入してループ再開。`--check-retries`(既定2)回まで。max-time / max-iterations の残り予算内でのみ。
- `--json` 出力に追加:
  ```json
  "check": { "command": "...", "exit_code": 0, "attempts": 1, "output_tail": "<末尾2000chars>" }
  ```
- check 最終失敗でも結果は返す(status は `ok` のまま、check フィールドで判断させる。または status=`check_failed` を新設 → **status 新設を推奨**。exit code は 1)。
- SessionRecord にも check 結果を保存(セッション JSON 後方互換: フィールド追加のみ)。

**実装ポイント**: `src/index.ts`(フラグ解析・runOneShot)、`src/agent.ts`(ループ再突入; max-time watchdog と干渉しないよう予算を確認)、`src/session.ts`(SessionRecord 拡張)。check コマンド実行は既存 bash ツールの実行系ではなく素の spawn でよい(権限確認不要: 呼び出し元が明示指定したコマンドのため)。

**効果測定**: eval/run.ts の `DELEGATE_NUDGE` を「`--check "<タスクの受け入れコマンド>"` を付けよ / check.exit_code==0 なら再検証は git diff 一読だけでよい」に更新し、委譲6タスクを再実行。合格条件: (a) no-repro が PASS になる、(b) 委譲アームのオーケストレーターコストが現行($0.107〜0.154)から低下、(c) 6/6 PASS 維持。

## P0-2: 結果 JSON を機械検証可能な報告書にする

> **✅ 実装済み(2026-07-06、手動)。** `--json`・SessionRecord に `report.changed_files`(write/edit 経由)と `report.commands_run` を追加。第3ラウンドの `DELEGATE_NUDGE` が report.changed_files 確認を指示し、オーケストレータの検証に使用された。

**目的**: 弱点2。呼び出し元の `git diff`・再 read・確認コマンドのターンを削る。

**仕様**: `--json` 出力に追加:
```json
"report": {
  "changed_files": [ { "path": "src/lib/fmt.ts", "action": "created|modified|deleted" } ],
  "commands_run": ["bun test"]
}
```
- `changed_files` は write/edit ツールの実行記録から生成(確実)。bash 経由のファイル変更(rm/mv 等)は追跡不能なので「bash による変更は含まれない」と README/SKILL.md に明記(嘘の網羅性を主張しない)。可能なら bash ツール実行後の簡易検出(cwd の mtime 走査)は**やらない**——コスト対効果が悪くノイズ源になる。
- `commands_run` は bash ツールで実行したコマンド列(トランケート)。

**実装ポイント**: `src/tools/write.ts` / `edit.ts` の実行結果をエージェントかレジストリでイベント収集(usage イベントと同様のパターン)、`src/index.ts` の JSON 組み立てに追加。SessionRecord にも保存。

**効果測定**: P0-1 と同じ再実行に相乗り。nudge に「report.changed_files を読み、想定外のファイルが無いか確認」を含め、オーケストレーターの turns が減るかを見る。

## P1-1: `--kind` タグ + 種類別 stats

> **✅ 実装済み(2026-07-06、手動)。** 第3ラウンドで全6タスクに `--kind` を付与(docs/bugfix/perf/rename/types/tests)、`lh stats --by-kind` が利用可能。SKILL.md / AGENTS-snippet.md も同期済み。

**目的**: SKILL.md は「種類ごとの合格率が悪ければその種類の委譲をやめよ」と指示するが、feedback レコードに種類フィールドが無く集計不能。委譲判断の学習ループを実データで回せるようにする。

**仕様**:
```bash
lh -p "..." --kind rename|tests|docs|types|perf|bugfix|other
lh stats --by-kind
```
- `--kind` は自由文字列(enum 強制しない。上記は推奨語彙として --help に記載)。SessionRecord と `lh feedback` の FeedbackRecord 両方に記録(feedback 時は session から引き継ぎ)。
- `lh stats --by-kind`: kind ごとの件数・pass率・平均 duration。kind 未記録の旧レコードは `(untagged)` に集約。
- SKILL.md / integrations/codex/AGENTS-snippet.md に「作業指示には --kind を付ける」「委譲判断前に `lh stats --by-kind` を見る」を追記。

**実装ポイント**: `src/index.ts`(フラグ)、`src/session.ts`(2レコード型の拡張と stats 集計)。後方互換: フィールドはすべて optional。

## P1-2: submit / wait 非同期モード

> **✅ 実装済み(2026-07-06、手動)。** `lh submit` / `lh wait` / `lh poll` サブコマンドを追加(SessionRecord に `running` 状態と `pid`)。**ただし本節「効果測定」の submit/wait による呼び出し元ブロック時間短縮の実測は未実施(オープン)。** 第3ラウンドは同期実行だったため submit フローの壁時計削減効果は未計測。

**目的**: 弱点3。呼び出し元の Bash が最大20分ブロックされる問題を解消し、待ち時間に別作業をさせる。

**仕様**:
```bash
lh submit -p "<作業指示>" --json [-‐check ...]   # 即座に {"session_id": "...", "status": "running"} を返す
lh wait <session_id> [--timeout 1200] --json     # 完了までブロックし、完了後は一発実行と同じ JSON を返す
lh poll <session_id> --json                       # ノンブロッキングで {"status": "running|ok|..."} を返す
```
- `submit` は detach した子プロセス(`Bun.spawn` + `unref`)で通常の one-shot を起動し、セッション JSON に `status: "running"` を先行書き込み。完了時に子が上書き。
- `wait`/`poll` はセッションファイルを監視(ポーリング間隔2秒程度で十分)。プロセス死亡検出: セッション JSON に子 pid を記録し、pid 消滅かつ status=running なら status=`died` を返す。
- 排他: 同一マシンで並行 submit は可(Ollama 側がキューイング)。ドキュメントに「27B は実質直列」と明記。

**実装ポイント**: `src/index.ts` にサブコマンド追加(既存は `lh feedback`/`lh stats`/`lh sessions` のパターンがある)、`src/session.ts` に running 状態と pid フィールド。**注意(メモリより)**: Bun の fetch アイドルタイムアウト問題は detach 子プロセスでも同様に `timeout: false` が効いていること(ollama.ts 実装済み)を確認。

**効果測定**: SKILL.md に「大きいタスクは submit → 自分の作業 → wait」パターンを追記し、rename-sweep 級で呼び出し元の実効ブロック時間が短縮されることを1回実測。

## P2(小粒・ドキュメント中心)

1. **`--resume <session_id>`**: check 失敗や部分的な差し戻し時、フル作業指示を再説明せず同一コンテキストに追撃指示。セッションは全 transcript(`ChatMessage[]`)を保存済みなので復元は素直。one-shot 専用(REPL は対象外)。効果: 再委譲1回分のプロンプト再構築コスト削減。
2. **stdin 作業指示の推奨**: `lh -p -` は実装済み。シェルクォート事故(実験中に Haiku 版 nudge 設計でも問題化)の回避策として SKILL.md / AGENTS-snippet.md / README の呼び出し例を heredoc + `-p -` 形式に更新するだけ。実装変更なし。
3. **`--worktree` パッチモード(検討のみ)**: 隔離 git worktree で作業し diff を返し、呼び出し元が検証後 apply。受け入れがアトミックになる。実装コストが高く(worktree 管理・非 git リポジトリの扱い)、P0-1 の check で品質リスクは大半塞がるため、**P0/P1 の効果測定後に必要性を再判断**。

---

## 実施順序と全体の検証プロトコル

1. P0-1 → P0-2 を実装(1コミット)。ユニットテスト: check リトライ判定・report 収集を純関数に切り出してテスト(thinking watchdog の `shouldInterruptThinking` と同じパターン)。
2. `DELEGATE_NUDGE` を --check 前提に更新し、委譲6タスクを再実行(**注意: eval 実行はサブエージェントからは権限クラシファイアに拒否される。ユーザー承認を得てメインセッションから直接実行**)。第1ラウンドのアーカイブ(eval/results/*.round1.* 方式)を踏襲し、実行前に現行結果を退避。
3. 結果を eval/REPORT.md に追記(改良前後の比較表)。合格条件: no-repro PASS 回復・6/6 PASS・オーケストレーターコスト低下・floor はほぼ不変(はず)という予測の明記。
4. P1-1 → P1-2 を実装(各1コミット)。P1-2 は rename-sweep 級1タスクで実測。
5. SKILL.md(原本 integrations/claude-code/ + インストール版 ~/.claude/skills/)と AGENTS-snippet.md と README「使い所」節を新機能に同期。
6. メモリ(localllm-harness-project.md)の委譲検証 bullet に改良結果を追記。

## 未確定の入力(実行時に確認)

- **Haiku ワーカー対照実験**(claude-delegate-haiku アーム)= 実施済み・**H1 確認**。委譲先を課金 `claude --model haiku` に替えてもオーケストレータのみコストは lh 版 $0.813 vs Haiku 版 $0.907(+12%、単発計測のばらつき範囲)でほぼ不変——floor は委譲先非依存の呼び出し元側構造費と判明した。よって本計画の「floor は動かない」前提はそのまま成立する(P0-1 が削るのはオーケストレータの再検証コストと委譲判断であって、床そのものではない)。あわせて **H2 が P0-1(`--check`)の狙う故障クラスを実証**: no-repro で Haiku は厳密1行目フォーマットを守り 6/6、Qwen は同フォーマットを外して 5/6——`--check` の受け入れコマンド自己検証はまさにこの「実質は正しいが厳密ゲートを外す」失敗を捕捉する。詳細は eval/REPORT.md「Haikuワーカー対照実験」。
- 評価タスクの規模が小さい(baseline 最大 $0.34)ため節約幅が圧縮されている問題は本計画のスコープ外。委譲が真に効く領域の実測には重量級タスク(40ファイル級移行、baseline $1 超)の fixture 追加が別途必要(eval/README.md の三重検証プロトコルに従うこと)。
