import type { PortalUser } from "./types";

const MAX_TERM_LENGTH = 64;
const MAX_TERMS = 256;

export function normalizePortalUserSearch(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export function portalUserSearchTerms(user: Pick<PortalUser, "normalized_email" | "display_name">): string[] {
  const email = normalizePortalUserSearch(user.normalized_email);
  const displayName = normalizePortalUserSearch(user.display_name);
  const candidates = [email, displayName, ...email.split(/[@._+-]+/u), ...displayName.split(/[\s._+-]+/u)]
    .filter(Boolean);
  const terms = new Set<string>();
  for (const candidate of candidates) {
    const characters = Array.from(candidate).slice(0, MAX_TERM_LENGTH);
    for (let length = 1; length <= characters.length && terms.size < MAX_TERMS; length += 1) {
      terms.add(characters.slice(0, length).join(""));
    }
    if (terms.size >= MAX_TERMS) break;
  }
  return [...terms].sort();
}
