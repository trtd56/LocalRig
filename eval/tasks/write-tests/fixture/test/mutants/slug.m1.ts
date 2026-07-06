// MUTANT m1: slugify が小文字化しない (仕様違反)。
// 正しいテストなら slugify("Hello") のような大文字入力で落ちるはず。
export function slugify(s: string): string {
  return s
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function truncateWords(s: string, maxWords: number): string {
  if (maxWords <= 0) throw new Error("maxWords must be greater than 0");
  const words = s.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ") + "…";
}
