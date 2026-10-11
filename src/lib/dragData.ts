/**
 * What the browser hands to whatever it is dropped on: an instrument (by its name in the instrument list) or a
 * sample (by its id). Carried in a type of its own, so dropping a file or some text from elsewhere is ignored.
 */
export const DRAG_TYPE = "application/x-pulsegrid-item";

export type DragItem = { kind: "instrument"; label: string } | { kind: "sample"; id: string; name: string };

export function encodeDragItem(item: DragItem): string {
  return JSON.stringify(item);
}

/** Read a drag back, or null for anything that isn't one of ours. */
export function decodeDragItem(raw: string | null | undefined): DragItem | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.kind === "instrument" && typeof value.label === "string" && value.label) {
      return { kind: "instrument", label: value.label.slice(0, 120) };
    }
    if (value?.kind === "sample" && typeof value.id === "string" && value.id) {
      return { kind: "sample", id: value.id.slice(0, 200), name: typeof value.name === "string" ? value.name.slice(0, 120) : "Sample" };
    }
  } catch {
    /* not ours */
  }
  return null;
}

/** Does this drag carry one of ours? (While dragging, only the types can be read, not the data.) */
export function carriesDragItem(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes(DRAG_TYPE);
}
