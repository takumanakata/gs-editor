const GS_EXT = /\.(ply|spz|splat|ksplat|sog)$/i;

/**
 * The intake (Japanese on purpose: this section and the history are the two the
 * user reads in Japanese): a GS file, dropped or picked, goes straight into the viewer.
 */
export class IntakePanel {
  constructor(
    container: HTMLElement,
    private onResult: (url: string, file: File) => void,
    private logSink: (text: string) => void = () => {},
  ) {
    container.innerHTML = `
      <button class="sbtn wide" id="in-pick"><i class="ti ti-folder-open"></i> ファイルを選択</button>
      <div class="drop" id="in-drop">
        <i class="ti ti-upload"></i>
        <div>GS ファイルをここにドロップ</div>
        <small>.ply / .spz / .splat / .ksplat・複数可（別オブジェクトとして並びます）</small>
      </div>
      <input id="in-file" type="file" multiple accept=".ply,.spz,.splat,.ksplat,.sog" class="hidden">
    `;
    const drop = container.querySelector("#in-drop") as HTMLDivElement;
    const file = container.querySelector("#in-file") as HTMLInputElement;
    (container.querySelector("#in-pick") as HTMLButtonElement).onclick = () => file.click();
    drop.onclick = () => file.click();
    file.onchange = () => { if (file.files?.length) this.handleFiles(Array.from(file.files)); file.value = ""; };
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) this.handleFiles(files);
    });
  }

  /** Public so a viewer-wide drop can route here too. Every GS file becomes an object. */
  handleFiles(files: File[]) {
    const gs = files.filter((x) => GS_EXT.test(x.name));
    if (!gs.length) { this.logSink("Unsupported file (GS files only: .ply / .spz / .splat / .ksplat)"); return; }
    for (const f of gs) this.onResult(URL.createObjectURL(f), f); // the File is kept by the host for the full-quality export
  }
}
