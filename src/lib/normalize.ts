export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

/**
 * Normalizes phone numbers to a +<digits> form. Numbers without a country code
 * are assumed to be Indian (+91) when they have exactly 10 digits.
 */
export function normalizePhone(phone?: string | null, defaultCountryCode = "91"): string | null {
  if (!phone) return null;
  const hasPlus = phone.trim().startsWith("+");
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (!hasPlus) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
    else if (digits.length === 10) digits = defaultCountryCode + digits;
  }
  return `+${digits}`;
}

export function buildSearchText(...parts: Array<string | null | undefined>) {
  return parts
    .filter(Boolean)
    .map((p) => String(p).toLowerCase().trim())
    .join(" ");
}
