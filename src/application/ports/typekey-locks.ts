import type { LabourInput } from "../../domain/labour/types.js";

export interface TypekeyLocks {
  claim(requestId: string, input: LabourInput): Promise<string[]>;
  release(requestId: string, paths: string[]): Promise<void>;
  renew(requestId: string): Promise<void>;
  hashPath(path: string): string;
}
