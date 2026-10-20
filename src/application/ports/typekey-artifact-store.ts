export interface TypekeyArtifactStore {
  objectKey(...parts: string[]): string;
  putJson(key: string, value: unknown): Promise<void>;
  putJsonCompact(key: string, value: unknown): Promise<void>;
  getJsonIfExists<T>(key: string): Promise<T | undefined>;
  deletePrefix(prefix: string): Promise<number>;
}
