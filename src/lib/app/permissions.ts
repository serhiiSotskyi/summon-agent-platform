import type { MembershipRole } from "@prisma/client";

export function canManageWorkspace(role: MembershipRole | null) {
  return role === "OWNER" || role === "ADMIN";
}

export function canCreateAgent(role: MembershipRole | null) {
  return role === "OWNER" || role === "ADMIN" || role === "CREATOR";
}

export function canRunAgent(role: MembershipRole | null) {
  return canCreateAgent(role);
}
