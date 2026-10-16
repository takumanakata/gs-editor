# 開発メモ（GSEditor）

純静的サイト。`master` に push すると GitHub Actions（`.github/workflows/pages.yml`）がビルドして
GitHub Pages（https://takumanakata.github.io/gs-editor/）に出す。サーバー処理は無い。

```
_dev/web/     Vite + TypeScript + three.js + Spark(@sparkjsdev/spark) + @playcanvas/splat-transform
  src/main.ts            配線（オブジェクト／ボリューム／active の管理、ジェスチャ、キーボード、書き出し）
  src/ui/                Editor（外枠と右パネル）、TransformPanel、VolumePanel、NumField、IntakePanel、HistoryPanel
  src/viewer/            Scene（グリッド・平行投影の相棒カメラ・ビュー依存ガイド）、SplatScene、SplatEditor（選択・クリップ・削除）、
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
- `GsObject {id,name,source,mesh,frame,edit,visible}` の一覧と `ClipVolume` の一覧。active は object か volume のどちらか
- `SplatEditor` は粒ごとに `hiddenFlag`（削除）・`clipFlag`（ボリュームで非表示：選べないが書き出しには入る）・`selFlag`（オレンジ）。
  箱／丸／投げ縄の選択は `project()` のスクリーン座標で判定
- 書き出し：画面上の変換は `SceneFrame.root` に掛かっている。`SplatScene.FILE_FLIP`（OpenCV Y-down → Y-up の 180° 反転）は
  ビューアの都合なので書き出し時には外す。元ファイルを `@playcanvas/splat-transform` で読み直し（`bakeFiles`、複数ファイルを
  1つにまとめる）、消した行を落とし、位置・回転・スケール・SH を変換して書く。読み直せない場合は表示データから書く（基本色のみ）。
  保存先は `showSaveFilePicker`（焼き込みの前に呼ぶ）、非対応ブラウザはダウンロード。既定は `.spz`
- ナビは Blender：MMB 回転（選択の重心か、カーソル下の面を中心）、Shift+MMB 移動（OrbitControls は Shift で ROTATE→PAN を
  自分で入れ替えるので、Ctrl だけ DOLLY に割り当てる）、ホイール前後。軸ビューは平行投影の相棒カメラ（`scene.ortho`）に切り替え、
  グリッドはビューで変わる（透視では薄い床、Top では濃い床、Front/Side では縦グリッドと高さの軸）
- ビューキューブは CSS 3D。面クリックでスナップ、ドラッグで `nav.rotateBy`。行列は F·R·F で鏡像を防ぐ
- ダブルクリックの寄りは Layouter と同じ規則（30%、遠ざからない）
- `viewer/startFrame.ts` は GSLayouter と同一ファイル（最初の画を揃えるため）。片方だけ変えないこと
- ブラウザには何も保存しない（以前あった sidecar／localStorage の記憶は撤去）。リロードでファイルそのままに戻る
- 見た目は design.md 準拠：暗い全面ビューにすりガラスのフローティング UI、`corner-shape: superellipse(2)`、IBM Plex、Tabler Icons。
  表示は英語（読み込みパネルと履歴の行だけ日本語）

## ライセンス

MIT。表示側 Spark / three.js、書き出し側 @playcanvas/splat-transform もすべて MIT。
