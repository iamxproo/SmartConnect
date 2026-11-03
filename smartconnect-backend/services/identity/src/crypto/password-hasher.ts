// Password hashing: Argon2id (docs/database/schema-design.md: credentials.secret), parameters per the OWASP
// Password Storage Cheat Sheet. Hashing runs on libuv's thread pool (4 threads by default), which also bounds
// concurrent memory use to 4 × 19 MiB however many logins arrive at once.
import { hash, parseOptions, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `Algorithm` is a TypeScript `const enum` in the library's typings (absent at runtime), so the value is spelled
 * out: Argon2d = 0, Argon2i = 1, Argon2id = 2. test/password-hasher.test.ts asserts the resulting PHC string.
 */
const ARGON2ID = 2 as Algorithm;

export interface PasswordHashParams {
  algorithm: Algorithm;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const PASSWORD_HASH_PARAMS: Readonly<PasswordHashParams> = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
};

/** NFKC, so that visually identical passwords typed on different keyboards/IMEs match (NIST SP 800-63B §5.1.1.2). */
const normalize = (password: string) => password.normalize('NFKC');

export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly params: Readonly<PasswordHashParams> = PASSWORD_HASH_PARAMS) {}

  hash(password: string): Promise<string> {
    return hash(normalize(password), this.params);
  }

  /**
   * Constant-cost verification: without a stored hash (unknown account, no password credential) a dummy hash with
   * the same parameters is checked instead, so response time does not reveal whether an account exists.
   */
  async verify(storedHash: string | undefined, password: string): Promise<boolean> {
    const target = storedHash ?? (await (this.dummyHash ??= this.hash(`dummy:${Math.random()}`)));
    try {
      const valid = await verify(target, normalize(password));
      return storedHash !== undefined && valid;
    } catch {
      return false; // malformed stored hash: treat as a failed login, never as a crash
    }
  }

  /** True when a stored hash uses other parameters than the current ones (upgraded on the next successful login). */
  needsRehash(storedHash: string): boolean {
    try {
      const current = parseOptions(storedHash);
      return (
        current.algorithm !== this.params.algorithm ||
        current.memoryCost !== this.params.memoryCost ||
        current.timeCost !== this.params.timeCost ||
        current.parallelism !== this.params.parallelism
      );
    } catch {
      return true;
    }
  }
}
