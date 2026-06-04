"use server";

import { redirect } from "next/navigation";
import {
  getAuthenticatedDbUser,
  ensurePersonalWorkspace,
} from "@/lib/app/context";
import { acceptWorkspaceInvitationForUser } from "@/lib/app/invitations";

export async function acceptWorkspaceInvitation(formData: FormData) {
  const token = formData.get("token");

  if (typeof token !== "string" || !token.trim()) {
    redirect("/invite/invalid?error=invalid");
  }

  const authenticatedUser = await getAuthenticatedDbUser();
  if (!authenticatedUser) {
    redirect(`/invite/${token}?error=auth-required`);
  }

  await ensurePersonalWorkspace(authenticatedUser.user);
  const result = await acceptWorkspaceInvitationForUser(
    token,
    authenticatedUser.user,
  );

  if (result.status === "accepted") {
    redirect(`/app?workspace=${result.workspaceId}`);
  }

  redirect(`/invite/${token}?error=${result.status}`);
}
