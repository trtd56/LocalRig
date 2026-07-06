/**
 * 文字列を URL に使いやすいスラッグへ変換する。
 *
 * 仕様:
 * - 全体を小文字化する。
 * - 英数字 (a-z, 0-9) 以外の 1 文字以上の連続を、単一の "-" に置換する。
 * - 先頭と末尾の "-" はすべて除去する。
 * - 結果が空になった場合は "" を返す。
 *
 * @example slugify("Hello, World!")   // "hello-world"
 * @example slugify("  --Foo__Bar-- ") // "foo-bar"
 * @example slugify("café & CRÈME")    // "caf-cr-me"  (非英数字は "-" になる)
 * @example slugify("!!!")             // ""
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * 空白区切りで最初の `maxWords` 語だけを残す。
 *
 * 仕様:
 * - 入力を空白の連続で語に分割する (前後・連続する空白は無視され、空語は生じない)。
 * - 語数が `maxWords` 以下ならそのまま、語を単一スペースで連結して返す (末尾に何も付けない)。
 * - 語数が `maxWords` を超える場合のみ、先頭 `maxWords` 語を単一スペースで連結し、
 *   末尾に単一の "…" (U+2026, 三点リーダ 1 文字) を付与する。
 * - `maxWords` が 0 以下のときは Error を throw する。
 *
 * @throws {Error} `maxWords` が 0 以下のとき。
 *
 * @example truncateWords("a b c d", 2) // "a b…"
 * @example truncateWords("a b", 2)     // "a b"   (ちょうど maxWords なので付与しない)
 * @example truncateWords("a b", 5)     // "a b"
 * @example truncateWords("  one   two  ", 1) // "one…"
 */
export function truncateWords(s: string, maxWords: number): string {
  if (maxWords <= 0) throw new Error("maxWords must be greater than 0");
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ") + "…";
}
