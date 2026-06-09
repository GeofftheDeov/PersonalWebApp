import express, { Response } from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import ApiKeyVault from '../models/ApiKeyVault.js';
import { encrypt, decrypt } from '../utils/encryption.js';

const router = express.Router();

// ── GET /api/api-keys ─────────────────────────────────────────────────────────
// List all stored providers for the authenticated user.
// Secrets are never returned — only a redacted preview of the key ID.
router.get('/', auth, async (req: any, res: Response) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const entries = await ApiKeyVault.find({ userId }).lean();
    res.json(entries.map(e => ({
      provider: e.provider,
      label: e.label,
      keyIdPreview: (() => {
        try { const v = decrypt(e.encryptedKeyId); return v.slice(0, 8) + '…'; }
        catch { return '[encrypted]'; }
      })(),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/api-keys/:provider ───────────────────────────────────────────────
// Create or update the key pair for a given provider.
// Body: { keyId: string, secret: string, label?: string }
router.put('/:provider', auth, async (req: any, res: Response) => {
  const { keyId, secret, label } = req.body as { keyId?: string; secret?: string; label?: string };
  if (!keyId?.trim() || !secret?.trim()) {
    return res.status(400).json({ error: 'keyId and secret are required' });
  }
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { provider } = req.params;

    await ApiKeyVault.findOneAndUpdate(
      { userId, provider },
      {
        encryptedKeyId:  encrypt(keyId.trim()),
        encryptedSecret: encrypt(secret.trim()),
        label: label?.trim() || '',
        updatedAt: new Date(),
      },
      { upsert: true, new: true },
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/api-keys/:provider ────────────────────────────────────────────
router.delete('/:provider', auth, async (req: any, res: Response) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    await ApiKeyVault.findOneAndDelete({ userId, provider: req.params.provider });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Retrieve decrypted keys for a specific user+provider.
 * Used internally by admin routes — NOT exposed as an HTTP handler.
 */
export async function getDecryptedKeys(
  userId: mongoose.Types.ObjectId,
  provider: string,
): Promise<{ keyId: string; secret: string } | null> {
  const entry = await ApiKeyVault.findOne({ userId, provider }).lean();
  if (!entry) return null;
  try {
    return { keyId: decrypt(entry.encryptedKeyId), secret: decrypt(entry.encryptedSecret) };
  } catch {
    return null;
  }
}

export default router;
