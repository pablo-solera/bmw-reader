export function createLabourTypekeyJobId(requestId: string, runId: string, index: number) {
  return `${requestId}--${runId}--${index}`;
}
