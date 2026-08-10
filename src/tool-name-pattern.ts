/**
 * Matches one complete, case-sensitive tool name against a compact glob pattern.
 * `*` matches zero or more characters and `?` matches exactly one character.
 */
export function matchesToolNamePattern(toolName: string, pattern: string): boolean {
  const nameCharacters = [...toolName];
  const patternCharacters = [...pattern];
  let nameIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starNameIndex = -1;

  while (nameIndex < nameCharacters.length) {
    const patternCharacter = patternCharacters[patternIndex];
    if (patternCharacter === "?" || patternCharacter === nameCharacters[nameIndex]) {
      nameIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (patternCharacter === "*") {
      starIndex = patternIndex;
      starNameIndex = nameIndex;
      patternIndex += 1;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starNameIndex += 1;
      nameIndex = starNameIndex;
      continue;
    }
    return false;
  }

  while (patternCharacters[patternIndex] === "*") {
    patternIndex += 1;
  }
  return patternIndex === patternCharacters.length;
}

/**
 * Checks whether a tool name matches any configured pattern.
 */
export function matchesAnyToolNamePattern(
  toolName: string,
  patterns: readonly string[] | undefined
): boolean {
  return patterns?.some((pattern) => matchesToolNamePattern(toolName, pattern)) ?? false;
}
