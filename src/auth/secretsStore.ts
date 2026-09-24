import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { isTokenSet, type TokenSet, type TokenStore } from "./tokenStore.js";

/**
 * Shape of the JSON document stored in the Secrets Manager secret.
 *
 * The operator creates the secret with the app credentials and an access key;
 * the server adds and rotates the `tokens` field itself. Unknown fields are
 * preserved on every write.
 */
export interface SecretDocument {
  EXACT_CLIENT_ID?: string;
  EXACT_CLIENT_SECRET?: string;
  /** Shared secret that protects the public MCP and /auth endpoints. */
  MCP_ACCESS_KEY?: string;
  tokens?: TokenSet;
  [key: string]: unknown;
}

/**
 * Token store backed by a single AWS Secrets Manager secret (JSON).
 *
 * Every load() reads the secret fresh, so a Lambda instance always sees a
 * refresh token rotated by another instance before it attempts its own refresh.
 */
export class SecretsManagerTokenStore implements TokenStore {
  private readonly sm = new SecretsManagerClient({});

  constructor(private readonly secretId: string) {}

  async readDocument(): Promise<SecretDocument> {
    const res = await this.sm.send(
      new GetSecretValueCommand({ SecretId: this.secretId })
    );
    if (!res.SecretString) {
      throw new Error(`Secret ${this.secretId} has no SecretString.`);
    }
    try {
      return JSON.parse(res.SecretString) as SecretDocument;
    } catch {
      throw new Error(`Secret ${this.secretId} does not contain valid JSON.`);
    }
  }

  async load(): Promise<TokenSet | undefined> {
    const doc = await this.readDocument();
    return isTokenSet(doc.tokens) ? doc.tokens : undefined;
  }

  async save(tokens: TokenSet): Promise<void> {
    const doc = await this.readDocument();
    doc.tokens = tokens;
    await this.sm.send(
      new PutSecretValueCommand({
        SecretId: this.secretId,
        SecretString: JSON.stringify(doc),
      })
    );
  }
}
