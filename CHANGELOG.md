# 変更履歴

## 0.3.0（2026-10-15）

- ブラウザだけで動く版として作り直し。GS を作る機能（動画・写真から）は無くし、開く・掃除する・原点と向きを直す・書き出す、に専念
- GitHub Pages で公開（push ごとに自動ビルド）。インストール不要
- 操作と画面を Blender に合わせた：中ドラッグで回転、Shift＋中で移動、ホイールで前後、G / R / S / O、`R` `Z` `90` ⏎ の数値入力、Ctrl+A（Apply Transform）
- 選択（箱／丸／投げ縄、W で切り替え）→ X で削除。Shift で追加、Ctrl で除外、Ctrl+I で反転。何もない所のクリックで解除
- Clip Volume（箱／球）で範囲の外側または内側を一時的に非表示。複数併用可。書き出しには影響しない
- 複数ファイルの読み込みと Outliner。Info の Replace File で中身だけ差し替え
- ビューキューブ（面クリックで軸ビュー＝平行投影、ドラッグで回転）。Top / Front / Side でグリッドが変わる
- Transform / Dimensions / Info / History のパネル。Dimensions は 3D ビューに箱と W / D / H を表示
- Export は保存先と名前を選ぶ画面（File System Access API。非対応ブラウザはダウンロード）。既定は .spz
- 自動水平・自動原点・床接地・ブラウザへの記憶はすべて無し。リロードでファイルそのままに戻る
