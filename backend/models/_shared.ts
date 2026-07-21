import bcrypt from "bcryptjs";

/** bcrypt-hash a modified plaintext password; skips existing bcrypt hashes. */
export async function hashPasswordHook(doc: any, ctx: { isModified: (f: string) => boolean }) {
  if (!ctx.isModified("password") || !doc.password) return;
  if (doc.password.startsWith("$2a$") || doc.password.startsWith("$2b$")) return;
  const salt = await bcrypt.genSalt(10);
  doc.password = await bcrypt.hash(doc.password, salt);
}

export const fourDigit = () => Math.floor(1000 + Math.random() * 9000).toString();
export const digitTag = (prefix: string) => () => `${prefix}-${Date.now()}`;
