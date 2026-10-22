/** A5-5: request logs keep the path only. Query strings carry embed JWTs and OAuth codes. */
export function logPath(url: string): string {
  const i = url.indexOf('?');
  return i < 0 ? url : url.slice(0, i);
}
