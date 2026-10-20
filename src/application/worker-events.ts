export function completedJobEvent(requestId: string, typekey: string | undefined, result: unknown) {
  return { event: "extraction_job_completed", requestId, typekey, result };
}

export function failedJobEvent(
  job: { data: { requestId: string; input?: { typekeys?: Array<{ typekey: string }> }; index?: number }; attemptsMade: number; opts: { attempts?: number } },
  error: Error,
  isFinalFailure: (error: Error) => boolean,
) {
  const retrying = !isFinalFailure(error) && job.attemptsMade < Number(job.opts.attempts ?? 1);
  return {
    event: retrying ? "extraction_attempt_failed" : "extraction_failed",
    requestId: job.data.requestId,
    typekey: job.data.input?.typekeys?.[Number(job.data.index)]?.typekey,
    attempt: job.attemptsMade,
    willRetry: retrying,
    error: error.message,
  };
}
