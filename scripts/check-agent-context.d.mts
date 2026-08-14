export const AGENTS_MAX_LINES: number;

export function paragraphs(text: string): string[];

export function evaluateAgentContext(input: {
  readText: (file: string) => string | null;
  readDir: (dir: string) => readonly string[];
  maxLines?: number;
}): string[];
