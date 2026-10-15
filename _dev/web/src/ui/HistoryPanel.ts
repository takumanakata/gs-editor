import type { History } from "../viewer/History";

/**
 * 編集履歴 panel (docked right, where the object list used to be). Every edit is a row,
 * newest at the bottom; the current step is highlighted; rows after it are greyed and
 * stay clickable (redo) until a new edit discards them. Clicking a row reverts to it.
 */
export class HistoryPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;

  constructor(host: HTMLElement, private onGoTo: (i: number) => void) {
    const el = document.createElement("div");
    el.id = "panel-history"; el.className = "panel glass open";
    el.innerHTML = `
      <h3><i class="ti ti-history"></i> 編集履歴 <span class="hp-dim">クリックで戻る · Ctrl+Z / Ctrl+Shift+Z</span></h3>
      <div id="hp-note" class="hp-note hidden"></div>
      <div id="hp-list"></div>
    `;
    host.appendChild(el);
    this.el = el;
    this.list = el.querySelector("#hp-list") as HTMLElement;
    this.note = el.querySelector("#hp-note") as HTMLElement;
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".hrow") as HTMLElement | null;
      if (row) this.onGoTo(+row.dataset.i!);
    });
  }

  render(h: History) {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rows = h.rows;
    const pos = h.position;
    const base = `<div class="hrow${pos === 0 ? " on" : ""}" data-i="0"><i class="ti ti-file"></i> 読み込んだ状態</div>`;
    this.list.innerHTML = base + rows.map((r, k) =>
      `<div class="hrow${k + 1 === pos ? " on" : ""}${r.applied ? "" : " future"}" data-i="${k + 1}" title="${r.applied ? "ここまで戻す" : "ここまでやり直す"}">${esc(r.label)}</div>`).join("");
    this.note.classList.toggle("hidden", h.dropped === 0);
    if (h.dropped > 0) this.note.textContent = `古い ${h.dropped} 件はメモリ節約のため破棄しました（最大 ${(h.constructor as any).MAX} 件）`;
    const cur = this.list.querySelector(".hrow.on") as HTMLElement | null;
    cur?.scrollIntoView({ block: "nearest" });
  }
}
