/** JSON.parse with bounded input and duplicate object member rejection. */
export function strictJson(source: string, limit = 262144): unknown {
  if (source.length > limit) throw new Error(`JSON exceeds ${limit / 1024} KiB`);
  const value: unknown = JSON.parse(source);
  const objects: Set<string>[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '{') objects.push(new Set());
    if (char === '}') objects.pop();
    if (char !== '"') continue;
    const start = i++;
    while (i < source.length) {
      if (source[i] === '\\') i += 2;
      else if (source[i] === '"') break;
      else i++;
    }
    let next = i + 1;
    while (/\s/.test(source[next] ?? '') && next < source.length) next++;
    if (source[next] === ':') {
      const key = JSON.parse(source.slice(start, i + 1)) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) throw new Error(`Duplicate JSON field ${key}`);
      keys.add(key);
    }
  }
  return value;
}
