export function addedChangesetFiles(diff) {
  return diff.split(/\r?\n/u).filter((file) => /^\.changeset\/[^/]+\.md$/u.test(file) && file !== '.changeset/README.md');
}

export function isReleaseChangeset(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? '';

  return /^[^#\s][^:]*:\s*(?:major|minor|patch)\s*$/mu.test(frontmatter);
}
