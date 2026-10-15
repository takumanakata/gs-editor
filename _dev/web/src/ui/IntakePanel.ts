const GS_EXT = /\.(ply|spz|splat|ksplat|sog)$/i;

/**
 * The intake: a GS file, dropped or picked, goes straight into the viewer. That is
 * all the Pages build does — there is no server, so nothing is generated here.
 */
export class IntakePanel {
  private container: HTMLElement;

  constructor(
    container: HTMLElement,
    private onResult: (url: string, file: File) => void,
    private logSink: (text: string) => void = () => {},
  ) {
    container.innerHTML = `
      <div class="drop" id="in-drop">
        <i class="ti ti-upload"></i>GS ファイルをここにドロップ
        <small>.ply / .spz / .splat / .ksplat・クリックで選択</small>
      </div>
      <input id="in-file" type="file" accept=".ply,.spz,.splat,.ksplat,.sog" class="hidden">
    `;
    this.container = container;
    const drop = container.querySelector("#in-drop") as HTMLDivElement;
    const file = container.querySelector("#in-file") as HTMLInputElement;
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

  /** Public so a viewer-wide drop can route here too. */
  handleFiles(files: File[]) {
    const f = files.find((x) => GS_EXT.test(x.name));
    if (!f) { this.logSink("対応していない種類です（GS ファイル .ply / .spz / .splat / .ksplat だけ開けます）"); return; }
    this.logSink(`読み込み: ${f.name}`);
    this.onResult(URL.createObjectURL(f), f); // the File is kept by the host for the full-quality export
  }
}
