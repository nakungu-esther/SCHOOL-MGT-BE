import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "./prisma";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return token;
}

export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const tokenHash = hashResetToken(token);
  const row = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!row) return { ok: false };

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new D