export function normalizeTitle(title) {
  if (!title) return "";

  return title
    .toLowerCase()
    .replace(/\(.*\)/g, "")
    .replace(/ - .*/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
