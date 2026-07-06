// MUTANT m3: truncateWords の off-by-one。語数がちょうど maxWords のときにも
// 切り詰めて "…" を付けてしまう (仕様違反)。
// 正しいテストなら truncateWords("a b", 2) === "a b" の境界で落ちるはず。
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function truncateWords(s: string, maxWords: number): string {
  if (maxWords <= 0) throw new Error("maxWords must be greater than 0");
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ") + "…";
}
