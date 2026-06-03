import { randomUUID } from "node:crypto";
import { Prisma, type Workspace, type WorkspaceType } from "@prisma/client";
import { getDb } from "@/lib/db";
import { slugify } from "./format";

function isUniqueSlugError(error: unknown) {
  const target =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? (error.meta?.target as string | string[] | undefined)
      : undefined;

  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    (target === "slug" || (Array.isArray(target) && target.includes("slug")))
  );
}

function candidateSlug(base: string, ownerId: string, attempt: number) {
  if (attempt === 0) {
    return `${base}-${ownerId.slice(-6)}`;
  }

  return `${base}-${ownerId.slice(-4)}-${randomUUID().slice(0, 8)}`;
}

export async function createWorkspaceWithOwnerMembership({
  name,
  ownerId,
  recoverFromSlugConflict,
  slugBase,
  type,
}: {
  name: string;
  ownerId: string;
  recoverFromSlugConflict?: () => Promise<Workspace | null>;
  slugBase?: string;
  type: WorkspaceType;
}) {
  const db = getDb();
  const base = slugify(slugBase || name) || "workspace";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.workspace.create({
        data: {
          name,
          slug: candidateSlug(base, ownerId, attempt),
          type,
          ownerId,
          memberships: {
            create: {
              userId: ownerId,
              role: "OWNER",
            },
          },
        },
      });
    } catch (error) {
      if (!isUniqueSlugError(error)) {
        throw error;
      }

      const recovered = await recoverFromSlugConflict?.();
      if (recovered) {
        return recovered;
      }
    }
  }

  throw new Error("Could not create a unique workspace slug.");
}
