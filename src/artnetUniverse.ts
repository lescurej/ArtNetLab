export function universeFieldHint(universe: number): string {
  const u = Math.max(0, Math.min(15, Math.round(universe)));
  return `Art-Net universe ${u} (0–15 in net/subnet/universe). Must match the node port you use.`;
}
