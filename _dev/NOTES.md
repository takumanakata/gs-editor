# 開発メモ（GSEditor）

純静的サイト。`master` に push すると GitHub Actions（`.github/workflows/pages.yml`）がビルドして
GitHub Pages（https://takumanakata.github.io/gs-editor/）に出す。サーバー処理は無い。

```
_dev/web/     Vite + TypeScript + three.js + Spark(@sparkjsdev/spark) + @playcanvas/splat-transform
  src/main.ts            配線（オブジェクト／ボリューム／active の管理、ジェスチャ、キーボード、書き出し）
  src/ui/                Editor（外枠と右パネル）、TransformPanel、VolumePanel、NumField、IntakePanel、HistoryPanel
  src/viewer/            Scene（グリッド・平行投影の相棒カメラ・ビュー依存ガイド）、SplatScene（読む・描く）、
                         ScanData（1スキャン＝全粒＋Worker＋描く用のコピー）、scanWorker（全粒の選択・削除・クリップ）、half（float16 表）、
                         SceneFrame（原点＝pivot と Apply Transform の基準）、NavControls、ViewCube、startFrame
  src/export/exportGS.ts 書き出し（元ファイルを読み直して焼き込む）
docs/         README の画像
```

```bash
npm --prefix _dev/web install
npm --prefix _dev/web run dev        # 開発サーバー
npm --prefix _dev/web test           # vitest
npm --prefix _dev/web run typecheck  # tsc --noEmit
```

- `01_Assets/`（git 管理外）に GS ファイルを置くと、開発サーバーで `?gs=<ファイル名>` で直接開ける
- Pages の `base` は `/gs-editor/`。Git Bash から渡すとパス変換されるので `MSYS_NO_PATHCONV=1`
- Pages のランナーは `npm install`（ローカルの lock と `npm ci` が合わないことがあった）

## 設計上の要点

- **Blender のオブジェクトと同じモデル。** `SceneFrame` は自分の原点（`pivot`、root ローカル）を持ち、回転・拡縮はそれを中心に起きる。
  `base` は Apply Transform（Ctrl+A）の基準で、パネルはそこからの相対値を読み、焼き込まれる root の変換は変わらない
- `GsObject {id,name,source,mesh,frame,data,visible}` の一覧と `ClipVolume` の一覧。active は object か volume のどちらか
- **大きいスキャン（`ScanData`）**：ファイルは `PackedSplats` として CPU に読むだけ（`SplatScene.read`）。描くのは別のコピー（`SplatScene.add`）。
  `LIGHT_MAX`（300万）を超えると Light：不透明度×大きい2軸の面積が大きい順に 300万粒を選び（パック済みの対数スケールのバイトを
  そのまま使うヒストグラムで、ソートなし）、少し大きく（比率^(1/8)）描く。Full は全粒をそのまま描く（そのときは全粒の配列＝描く配列。
  Light に戻すとき元の語に戻してから選び直す）
- **全粒の判定は Worker（`scanWorker.ts`）**：中心の float16（6バイト/粒）と状態ビット（削除1・クリップ2・選択4）を持ち、投影
  （Int16 のピクセル座標）、箱／丸（複数点）／投げ縄、クリップ、削除・復元、エクスポート行、寸法用サンプルを全部ここでやる。返事には
  「描いている粒のうち変わったもの」だけが入り、画面側はパック済みの語を直接書き換える（色の語＝選択の橙、スケールの語＝0で非表示）。
  メッセージは順番に処理されるので、画面側は投げっぱなしにして最後だけ待てばよい（`settle()`）
- 実測（このPC、1000万粒）：読み込み〜操作可能 約5秒、投影 0.18秒、箱選択 0.27秒、削除 0.34秒、画面側の停止は最大 0.05秒。
  描画は Light（300万）で 60fps、Full（1000万）で 49fps
- 書き出し：画面上の変換は `SceneFrame.root` に掛かっている。`SplatScene.FILE_FLIP`（OpenCV Y-down → Y-up の 180° 反転）は
  ビューアの都合なので書き出し時には外す。元ファイルを `@playcanvas/splat-transform` で読み直し（`bakeFiles`、複数ファイルを
  1つにまとめる）、消した行を落とし、位置・回転・スケール・SH を変換して書く。読み直せない場合は表示データから書く（基本色のみ）。
  保存先は `showSaveFilePicker`（焼き込みの前に呼ぶ）、非対応ブラウザはダウンロード。既定は `.spz`
- ナビは Blender：MMB 回転（選択の重心か、カーソル下の面を中心）、Shift+MMB 移動（OrbitControls は Shift で ROTATE→PAN を
  自分で入れ替えるので、Ctrl だけ DOLLY に割り当てる）、ホイール前後。軸ビューは平行投影の相棒カメラ（`scene.ortho`）に切り替え、
  グリッドはビューで変わる（透視では薄い床、Top では濃い床、Front/Side では縦グリッドと高さの軸）
- ビューキューブは CSS 3D。面クリックでスナップ、ドラッグで `nav.rotateBy`。行列は F·R·F で鏡像を防ぐ
- ダブルクリックの寄りは Layouter と同じ規則（30%、遠ざからない）
- 開発用 URL：`?light=<描く上限>` で小さいファイルでも Light を試せる。`?thin=stride`（k個おき）／`?bump=<指数>` は比較用
- `viewer/startFrame.ts` は GSLayouter と同一ファイル（最初の画を揃えるため）。片方だけ変えないこと
- ブラウザには何も保存しない（以前あった sidecar／localStorage の記憶は撤去）。リロードでファイルそのままに戻る
- 見た目は design.md 準拠：暗い全面ビューにすりガラスのフローティング UI、`corner-shape: superellipse(2)`、IBM Plex、Tabler Icons。
  表示は英語（読み込みパネルと履歴の行だけ日本語）

## ライセンス

MIT。表示側 Spark / three.js、書き出し側 @playcanvas/splat-transform もすべて MIT。
