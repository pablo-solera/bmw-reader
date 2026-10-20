export function createExtractionJobId(requestId: string, runId: string, index: number) {
  return `${requestId}--${runId}--${index}`;
}
