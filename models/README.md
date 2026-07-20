# ローカルモデルについて

## 現行既定: hf.co/InternScience/Agents-A1-Q4_K_M-GGUF:Q4_K_M（2026-07-21〜）

`ollama pull hf.co/InternScience/Agents-A1-Q4_K_M-GGUF:Q4_K_M` でそのまま取得できる公式配布
（arch `qwen35moe`, 34.7B MoE, Q4_K_M, 22GB, ctx 262144, capabilities: tools / thinking /
completion / vision, Apache 2.0）。Modelfile の自作は不要で、サンプリングは `src/config.ts` の
`AGENTS_A1_PROFILE`（temp 0.85 / top_p 0.95 / top_k 20 / presence 1.1、HF カード推奨値）が適用
される。選定根拠と実測は eval/REPORT.md「Agents-A1 比較ラウンド」、回帰ベースラインは
`eval/baselines/agents-a1-35b-q4km.json`（全20タスク PASS）。

# qwen36-27b-mtp:latest について（旧既定）

旧既定のローカルモデル `qwen36-27b-mtp:latest`（Ollama 上のカスタムビルド）の
再現用資料。`qwen36-27b-mtp.Modelfile` は `ollama show --modelfile qwen36-27b-mtp:latest` の
出力をそのまま保存したもの（無改変）。

## モデルの実体

`ollama show qwen36-27b-mtp:latest` および `/api/show` の `model_info` から判明した事実:

| 項目 | 値 |
|---|---|
| architecture | qwen35 |
| parameters | 27.3B (27,320,697,856) |
| context length | 262144 |
| embedding length | 5120 |
| quantization | Q4_K_S |
| format | gguf |
| capabilities | tools, thinking, completion |
| base model | Qwen/Qwen3.6-27B（`general.base_model.0.repo_url`: https://huggingface.co/Qwen/Qwen3.6-27B） |
| quantized by | Unsloth（`general.quantized_by`, リポジトリ https://huggingface.co/unsloth） |
| license | apache-2.0 |
| imatrix dataset | `unsloth_calibration_Qwen3.6-27B.txt`（Unsloth 提供の量子化用キャリブレーションデータ） |

`FROM` 行はローカル blob パス（`sha256-a5ef62184c1729c38c9565b502303ac88e2fad3b1c3c6aa430d9e273bdd7f917`）を
指しており、Modelfile 単体では素性を追えないが、`ollama show`（`/api/show` の `model_info`）の
GGUF メタデータに `general.base_model.*` が埋め込まれているため、上記の通りベースモデルを特定できた。
同じ digest を持つタグが `qwen3.6-27b-mtp:local` としても存在する（`ollama list` で確認、同一 blob）。

## Modelfile の要点

```
FROM /Users/s06330/.ollama/models/blobs/sha256-a5ef62184c1729c38c9565b502303ac88e2fad3b1c3c6aa430d9e273bdd7f917
TEMPLATE {{ .Prompt }}
PARAMETER temperature 0.2
PARAMETER top_p 0.9
```

- **PARAMETER**: `temperature 0.2` と `top_p 0.9` が設定されている。`presence_penalty` や `top_k` の指定はない。
- **TEMPLATE**: Modelfile 自体は `{{ .Prompt }}` という単純なテンプレートだが、これは `ollama show --modelfile`
  が出す簡略表示であり、実際にビルドに使われたテンプレートではない。`/api/show` の `template` フィールドを見ると、
  Qwen3 系の Jinja2 チャットテンプレート（`<tools>` ブロックでの function 定義注入、
  `<tool_call><function=...><parameter=...>` 形式のネイティブ tool-call フォーマット、`<think>...</think>` の
  reasoning ブロック処理など）がフルに入っている。つまり `ollama show` の `TEMPLATE {{ .Prompt }}` という
  表示だけを見ると素の補完テンプレートに見えるが、実際に api/chat 経由で使われているテンプレートは
  ネイティブ tool-call・thinking 対応の複雑な Jinja テンプレートであり、ハーネスで観測されている
  tool-call 機能や thinking 機能とは矛盾しない（`ollama show --modelfile` は要約表示であり、
  GGUF に埋め込まれた実テンプレートそのものではない可能性がある。この点は推測であり、
  `ollama show --modelfile` の実装詳細までは未確認）。

## src/config.ts のコメントとの食い違い

`src/config.ts:51-53` 付近のコメントは以下:

```ts
// Official Qwen anti-repetition lever (thinking preset uses 1.5, coding 0.0);
// the Modelfile sets none, so 1.0 breaks observed reasoning loops.
presencePenalty: Number(process.env.LH_PRESENCE_PENALTY ?? 1.0),
```

このコメントは「Modelfile は `presence_penalty` を設定していない」という主旨であり、これ自体は事実と
一致する（実際の Modelfile に `presence_penalty` の指定はない）。ただし Modelfile には
`PARAMETER temperature 0.2` と `PARAMETER top_p 0.9` が明示的に設定されており、これは
`defaultConfig`（`temperature: 0.6`, `topP: 0.95`, `topK: 20`）とは異なる値である。

**重要**: この差異は実害がない。`src/provider/ollama.ts` の `chat()` は毎リクエストで
`options: { num_ctx, num_predict, temperature, top_p, top_k, presence_penalty }` を明示的に
`/api/chat` へ送信しており（値は `src/agent.ts:299-302` で `this.config.*` から都度セットされる）、
Ollama は API リクエストの `options` を Modelfile の `PARAMETER` より優先する。したがって
Modelfile 側の `PARAMETER temperature 0.2` / `PARAMETER top_p 0.9` はこのハーネス経由の呼び出しでは
一切効かず、実効値は常に `src/config.ts` の `defaultConfig`（または環境変数オーバーライド）である。
`complete()`（コンパクション用の非ストリーミング呼び出し）も同様に `temperature` を明示送信しており
（デフォルト 0.2 だが呼び出し元次第で上書き可能）、Modelfile の値には依存しない。

## 新モデル導入時の手順

1. 変換済み GGUF などを Ollama に取り込み、必要なら独自の Modelfile を用意する。
   例:
   ```
   FROM /path/to/model.gguf
   TEMPLATE ...
   PARAMETER temperature ...
   ```
2. ビルド:
   ```sh
   ollama create <new-model-name> -f /path/to/Modelfile
   ```
3. 動作確認:
   ```sh
   ollama show <new-model-name>
   ollama run <new-model-name> "hello"
   ```
4. ハーネス側で使うモデル名を切り替える場合は `LH_MODEL` 環境変数、または
   `src/config.ts` の `defaultConfig.model` を更新する（本 README 作成時点では変更していない）。
5. サンプリングパラメータ（temperature/top_p/top_k/presence_penalty）は Modelfile ではなく
   `src/config.ts` 側で管理する方針であることに留意する（上記「食い違い」の節を参照）。
   Modelfile 側に `PARAMETER` を書いても、このハーネス経由の推論では上書きされ効果がない。
6. 新モデルでも本ハーネスの native tool-call / thinking 機能を使うには、Ollama 側のテンプレートが
   Qwen3 系と同様に `<tool_call>` 形式や `<think>` ブロックに対応している必要がある
   （`ollama show <name>` の `TEMPLATE` 出力、または `/api/show` の `template` フィールドで確認する）。

## 再現用ファイル一覧

- `qwen36-27b-mtp.Modelfile` — `ollama show --modelfile qwen36-27b-mtp:latest` の生出力（無改変）。
