export function normalizeComparable(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenJaccard(a: string | null | undefined, b: string | null | undefined): number {
  const aa = new Set(normalizeComparable(a).split(" ").filter(Boolean));
  const bb = new Set(normalizeComparable(b).split(" ").filter(Boolean));
  if (aa.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  for (const t of aa) {
    if (bb.has(t)) intersection++;
  }
  return intersection / (aa.size + bb.size - intersection);
}

export function jaroWinkler(a: string | null | undefined, b: string | null | undefined): number {
  const s1 = normalizeComparable(a);
  const s2 = normalizeComparable(b);
  if (s1 === s2 && s1.length > 0) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const m = matches;
  const jaro =
    (m / s1.length + m / s2.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] !== s2[i]) break;
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return Math.max(jaroWinkler(a, b), tokenJaccard(a, b));
}

export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number | null {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return null;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  if (aa === 0 || bb === 0) return null;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const aa = normalizeComparable(a);
  const bb = normalizeComparable(b);
  return aa.length > 0 && aa === bb;
}

