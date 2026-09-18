export function semverLt(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

function parse(v: string): [number, number, number] {
  const [maj, min, pat] = v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  return [maj, min, pat];
}
