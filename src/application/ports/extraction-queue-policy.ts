export const EXTRACTION_QUEUE_NAME = "bmw-extractions";

export const EXTRACTION_JOB_OPTIONS = {
  removeOnComplete: true,
  removeOnFail: 100,
  attempts: 2,
  backoff: { type: "exponential", delay: 30000 },
  ignoreDependencyOnFailure: true,
} as const;
