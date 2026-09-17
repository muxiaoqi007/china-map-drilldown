/** BLANK and invalid values stay missing; zero remains a real measurement. */
export function numericValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** Sum additive measures, preserving an all-BLANK group. */
export function addValues(left: number, right: number): number {
    if (!Number.isFinite(left)) return numericValue(right);
    if (!Number.isFinite(right)) return left;
    return numericValue(left + right);
}
