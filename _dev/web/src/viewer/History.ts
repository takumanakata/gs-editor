/**
 * Linear edit history (Photoshop-style). `entries[0..pos)` are applied; entries at
 * or after `pos` are the greyed "future" that a click can redo, until a new edit
 * discards them. Each entry knows how to undo and redo itself, so splat erases
 * (index batches) and scene-transform steps (before/after states) share one list.
 *
 * Memory: capped at MAX entries. An erase batch holds one index per splat, so on a
 * big scene 50 batches can still be tens of MB; the oldest step is dropped silently
 * from the bottom and `dropped` tells the panel how many were lost.
 */
export interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

export interface HistoryRow { label: string; applied: boolean; }

export class History {
  static readonly MAX = 50;
  private entries: HistoryEntry[] = [];
  private pos = 0;
  /** Steps discarded from the bottom to stay under MAX (shown in the panel). */
  dropped = 0;
  private onChange?: () => void;

  setOnChange(fn: () => void) { this.onChange = fn; }
  private changed() { this.onChange?.(); }

  get position() { return this.pos; }
  get length() { return this.entries.length; }
  get canUndo() { return this.pos > 0; }
  get canRedo() { return this.pos < this.entries.length; }
  get rows(): HistoryRow[] { return this.entries.map((e, i) => ({ label: e.label, applied: i < this.pos })); }
  /** Label of the step that would be undone next (for messages). */
  get currentLabel(): string | null { return this.pos > 0 ? this.entries[this.pos - 1].label : null; }

  /** Record an edit that has ALREADY been applied. Discards any redo-able future. */
  push(entry: HistoryEntry) {
    this.entries.length = this.pos;
    this.entries.push(entry);
    if (this.entries.length > History.MAX) { this.entries.shift(); this.dropped++; }
    this.pos = this.entries.length;
    this.changed();
  }

  /** Jump to the state after step `i` (0 = the loaded file); undoes or redoes as needed. */
  goTo(i: number) {
    const target = Math.max(0, Math.min(this.entries.length, Math.round(i)));
    if (target === this.pos) return;
    while (this.pos > target) { this.pos--; this.entries[this.pos].undo(); }
    while (this.pos < target) { this.entries[this.pos].redo(); this.pos++; }
    this.changed();
  }

  undo(): boolean { if (!this.canUndo) return false; this.goTo(this.pos - 1); return true; }
  redo(): boolean { if (!this.canRedo) return false; this.goTo(this.pos + 1); return true; }

  clear() { this.entries = []; this.pos = 0; this.dropped = 0; this.changed(); }
}
