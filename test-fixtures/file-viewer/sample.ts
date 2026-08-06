// Syntax-highlighting test: fileLanguage("sample.ts") -> "typescript".
// Keywords, strings, numbers and comments should each be a DIFFERENT
// colour. All-white text means highlight.js did not run.

interface Session {
  id: string;
  cwd: string;
  status: "idle" | "working" | "waiting_for_input";
}

const MAX_RETRIES = 3;

export async function resolveSession(id: string): Promise<Session | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`/session/${id}`);
      if (!response.ok) continue;
      return (await response.json()) as Session;
    } catch {
      // Swallow and retry -- a transient failure is expected here.
    }
  }
  return null;
}
