import type { PortalAccessPolicy, PortalRole, PortalSignInMutationInput } from "./types";

export function signInPolicyRole(
  input: PortalSignInMutationInput,
  emailPolicy: PortalAccessPolicy | null,
  domainPolicy: PortalAccessPolicy | null,
): PortalRole | null {
  const domain = input.normalizedEmail.split("@")[1] ?? "";
  if (
    emailPolicy?.enabled
    && emailPolicy.kind === "email"
    && emailPolicy.normalized_value === input.normalizedEmail
    && (emailPolicy.role === "visitor" || emailPolicy.role === "admin")
  ) {
    return emailPolicy.role;
  }
  if (
    domainPolicy?.enabled
    && domainPolicy.kind === "domain"
    && domainPolicy.normalized_value === domain
    && domainPolicy.role === "visitor"
  ) {
    return "visitor";
  }
  return null;
}
