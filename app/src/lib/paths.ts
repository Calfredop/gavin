export function folderName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : cwd;
}
