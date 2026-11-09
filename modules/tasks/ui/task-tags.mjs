// Names already stored on tags are not draft input: preserve a literal leading hash.
export function tagSuggestions(available, selected) {
  const assigned = new Set(selected.map((name) => name.toLowerCase()));
  return available.filter((tag) => !assigned.has(tag.name.toLowerCase())).slice(0, 8);
}

export async function findOrCreateTag(api, listId, name) {
  const path = `/tasks/lists/${listId}/tags`;
  const find = (tags) => tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
  const existing = find((await api("GET", path)).tags);
  if (existing) return existing;
  try {
    return (await api("POST", path, { name })).tag;
  } catch (error) {
    // A concurrent creator, or an acknowledged response lost in transit, may win.
    const found = find((await api("GET", path)).tags);
    if (!found) throw error;
    return found;
  }
}
