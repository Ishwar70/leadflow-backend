export function rate(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function winRate(won: number, lost: number) {
  return rate(won, won + lost);
}

export function conversionRate(converted: number, eligible: number) {
  return rate(converted, eligible);
}

export function averageDealValue(wonRevenue: number, wonCount: number) {
  if (!wonCount) return 0;
  return Math.round(wonRevenue / wonCount);
}

export function weightedForecast(deals: Array<{ value: number; probability: number }>) {
  return Math.round(deals.reduce((sum, d) => sum + (d.value * d.probability) / 100, 0));
}
