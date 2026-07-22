export function hasCodePointLength(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return false;
  }
  return length >= minimum;
}

export function clipTextToCodePoints(value: string, maximum: number): string {
  let length = 0;
  let end = 0;
  for (const character of value) {
    if (length === maximum) return value.slice(0, end);
    length += 1;
    end += character.length;
  }
  return value;
}
