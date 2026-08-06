export function minimumPayableTotal(calculatedGrand: number, tip: number) {
  return Math.max(0, calculatedGrand - tip);
}

export function payableTotal(calculatedGrand: number, overrideCents: number) {
  return overrideCents > 0 ? overrideCents : calculatedGrand;
}
