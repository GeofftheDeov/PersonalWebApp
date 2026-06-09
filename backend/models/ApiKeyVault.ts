import mongoose from 'mongoose';

/**
 * Per-user encrypted API key store.
 *
 * provider examples:  'alpaca_live'  'alpaca_paper'  'google'  'discord'
 *
 * encryptedKeyId / encryptedSecret are AES-256-GCM blobs produced by
 * backend/utils/encryption.ts.  The raw values are never persisted.
 */
const apiKeyVaultSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider:         { type: String, required: true },
  label:            { type: String, default: '' },
  encryptedKeyId:   { type: String, required: true },
  encryptedSecret:  { type: String, required: true },
  createdAt:        { type: Date, default: Date.now },
  updatedAt:        { type: Date, default: Date.now },
});

// One vault entry per user+provider combination
apiKeyVaultSchema.index({ userId: 1, provider: 1 }, { unique: true });

const ApiKeyVault = mongoose.model('ApiKeyVault', apiKeyVaultSchema);
export default ApiKeyVault;
