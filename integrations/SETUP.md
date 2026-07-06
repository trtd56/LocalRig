# Skill セットアップガイド

Claude Code / Codex から LocalRig (`lh`) へタスクを委譲できるようにするための導入手順。

## 全体像

```
Claude Code / Codex(上位エージェント)
   │  ① 機械的なタスクと判断したら委譲
   ▼
lh -p "作業指示" --json --cwd <repo>     ← LocalRig 上のローカル LLM(無料トークン)が実行
   │  ② JSON で session_id と結果が返る
   ▼
上位エージェントが diff / テストで検証
   │  ③ 採点を記録(必須)
   ▼
lh feedback <session_id> pass|fail --notes "..."
   │
   └→ lh stats に蓄積 → 何を委譲すべきかの較正に使う
```

## 1. 前提条件

| 要件 | 確認コマンド |
|---|---|
| [Bun](https://bun.sh) ≥ 1.2 | `bun --version` |
| [Ollama](https://ollama.com) 起動中 | `curl -s localhost:11434/api/version` |
| tools 対応モデル(既定: `qwen36-27b-mtp:latest`) | `ollama list` |
| `localrig` / `lh` コマンド | `which localrig` または `which lh`(なければ下記) |

`localrig` / `lh` が未登録なら、このリポジトリで:

```sh
bun install
bun link          # ~/.bun/bin/localrig と ~/.bun/bin/lh が作られる
localrig -h       # 動作確認
```

> `which localrig` / `which lh` が失敗する場合は `~/.bun/bin` が PATH に入っているか確認。

## 2. Claude Code のセットアップ

### 2-1. スキルのインストール

3 つの方法から選ぶ:

```sh
# A. ユーザースキル(全プロジェクトで有効) — 推奨
cp -r integrations/claude-code/delegate-local ~/.claude/skills/

# B. シンボリックリンク(このリポジトリでの編集が即反映される。開発中はこちら)
ln -s "$(pwd)/integrations/claude-code/delegate-local" ~/.claude/skills/delegate-local

# C. プロジェクトスキル(特定リポジトリだけで有効。チームに配りたい場合)
cp -r integrations/claude-code/delegate-local /path/to/repo/.claude/skills/
```

### 2-2. 動作確認

Claude Code を**新しいセッションで**起動し(スキルは起動時に読み込まれる):

1. 利用可能スキル一覧に `delegate-local` が出ることを確認(`/delegate-local` と打って補完されるか)
2. 明示的に試す: 「`/delegate-local` を使って README のタイポを直して」
3. 自動発動を試す: 「この単純な修正はローカルLLMに委譲して」

### 2-3. 権限設定(任意・推奨)

Claude Code は既定で `lh` 実行のたびに許可を求める。毎回の確認を省くには `~/.claude/settings.json`(またはプロジェクトの `.claude/settings.json`)の permissions に追加:

```json
{
  "permissions": {
    "allow": [
      "Bash(lh:*)"
    ]
  }
}
```

`lh feedback` / `lh stats` / `lh sessions` もこのルールでまとめて許可される。

### 2-4. 発動のしくみ

- スキルの `description`(SKILL.md の frontmatter)が判断基準。「単一ファイル修正・ボイラープレート・リネーム・既存パターンを踏襲したテスト追加・ドキュメント修正」のような**機械的で検証可能なタスク**のときに Claude Code が自律的に選択する
- ユーザーが `/delegate-local` と明示指定してもよい
- 委譲されないと感じたら「簡単な作業はローカルLLMに委譲して」と一言添えると発動しやすい

## 3. Codex のセットアップ

`integrations/codex/AGENTS-snippet.md` の「## Delegating small tasks to the local LLM (`lh`)」以下を追記する:

```sh
# グローバル(全プロジェクト)
cat integrations/codex/AGENTS-snippet.md >> ~/.codex/AGENTS.md

# またはプロジェクト単位
cat integrations/codex/AGENTS-snippet.md >> /path/to/repo/AGENTS.md
```

追記後、先頭の「# Codex integration」〜区切り線までの説明部分は不要なので削っておくと綺麗。

## 4. 運用ルール(フィードバックプロトコル)

スキルが上位エージェントに強制する 4 ステップ。人間が手動で使う場合も同じ流れを推奨:

1. **委譲判断**: ファイルパスと完了条件(通るべきコマンド)を明記できるタスクだけ委譲する。設計判断・複数ファイル横断・セキュリティ関連は委譲しない
2. **実行**: `lh -p "<作業指示書>" --json --cwd <repo>`。所要 1〜15 分なのでタイムアウトは長めに(Claude Code の Bash なら timeout 600000 か `run_in_background`)
3. **検証**: `git diff` と指示書に書いた検証コマンドを必ず実行。結果を鵜呑みにしない
4. **採点(必須)**: `lh feedback <session_id> pass|fail --source claude-code --notes "<理由>"`。fail のリトライは 1 回まで、2 回目は自分で修正

蓄積された採点は `lh stats` で確認。合格率が低いタスク種別は委譲をやめる、が基本方針。

## 5. トラブルシューティング

| 症状 | 対処 |
|---|---|
| スキルが一覧に出ない | Claude Code を再起動(スキルはセッション開始時に読み込み)。パスが `~/.claude/skills/delegate-local/SKILL.md` になっているか確認 |
| `lh: command not found` | `bun link` 実行済みか、`~/.bun/bin` が PATH にあるか。エージェント実行環境(非ログインシェル)では PATH が異なることがある → フルパス `~/.bun/bin/lh` を使うか settings で env 設定 |
| `fetch failed` / 接続エラー | Ollama 未起動。`ollama serve` または常駐確認。リモートの場合は env `OLLAMA_HOST` を設定 |
| タイムアウトで切られる | Claude Code の Bash timeout を 600000ms に。それでも長いタスクは `run_in_background` で投げて後で回収 |
| status が `max_iterations` / `loop_abort` | タスクが大きすぎるか曖昧。指示を分割・具体化して 1 回だけ再委譲。exit code 非 0 = 未完了扱い |
| セッション記録の場所を変えたい | env `LH_HOME`(既定 `~/.localrig`)。評価や実験ではセッションを分けると stats が汚れない |

## 5-1. 大きい/遅いタスク向けのチューニングフラグ

委譲元エージェントが `lh -p ... --json` に付けて渡せる主な調整フラグ。既定値は `lh --help` と同じ:

| フラグ | 効果 | 上書きが要る場面 |
|---|---|---|
| `--max-time SECONDS` | 実時間の予算。超過するとツール禁止のテキスト要約で打ち切り status=`timeout`(既定 `0`=無効) | 大きめと分かっているタスクを委譲するとき、CLI 既定(無効)より短い/明示的な上限を設定したい場合 |
| `--num-ctx N` | コンテキスト窓トークン数(既定 `32768`) | 参照ファイルが多い/大きいリポジトリで文脈が既定窓に収まらない場合(VRAM に余裕があれば拡大) |
| `--headroom TOKENS` | prune/compact 判定で現在推定に上乗せする予約トークン(既定 `4096`) | `--num-ctx` を上げたときや、次応答用の余裕を増減して圧縮タイミングを調整したい場合 |
| `--think-budget CHARS` | 出力開始前の thinking がこの文字数を超えたら中断・再試行(既定 `6000`) | 複雑な設計判断を要するタスクで暴走中断を避けたい/逆に早めに切り上げたい場合 |
| `--presence-penalty P` | 反復抑制ペナルティ(既定 `1.0`) | 観測された反復ループが強い/弱いタスク種別に合わせて微調整したい場合 |

## 6. スキルの更新

原本は `integrations/claude-code/delegate-local/SKILL.md`。コピー方式(2-1 の A/C)で入れた場合は編集後に再コピーが必要。シンボリックリンク方式(B)なら即反映(ただし Claude Code の再起動は必要)。

委譲の失敗パターンが `lh stats` に溜まってきたら、その内容を SKILL.md の「When to delegate / Do NOT delegate」基準に反映させるのが改善サイクル。
