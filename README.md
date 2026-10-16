# GSEditor

**写真から作った 3D シーン（ガウシアンスプラッティング）をブラウザで開いて、ゴミを消し、原点と向きを直して保存するツールです。**

**インストールは要りません。ブラウザで開くだけ →** https://takumanakata.github.io/gs-editor/
（Chrome か Edge で。ファイルはブラウザの中だけで処理され、どこにも送られません）

![GSEditor](docs/editor.png)

## 使い方

1. **GS ファイル**（.ply / .spz / .splat / .ksplat）を画面にドロップ
2. **見る**：中ドラッグで回転、Shift＋中ドラッグで移動、ホイールで前後。右上のキューブで Top / Front / Right
3. **消す**：左の Select で左ドラッグして粒を選び（W で 箱／丸／投げ縄）、**X** で削除
4. **原点と向き**：**O** で原点にしたい場所をクリック → **Alt+G** で世界原点へ → **R** で回して水平に
5. 右下の **Export**（.spz がいちばん軽い）

操作は Blender と同じです。G / R / S で移動・回転・スケール、`R` `Z` `90` ⏎ のような数値入力、Ctrl+Z で戻る。

## もう少し

| | |
|---|---|
| 選択 | Shift で追加、Ctrl で除外、A で全選択、Alt+A で解除、Ctrl+I で反転。丸は Shift＋ホイールで大きさ |
| Clip Volume | 左の箱／球ボタン。範囲の外（または内）を一時的に隠して、中を掃除しやすくする。書き出しには影響しない |
| 複数ファイル | 何枚でも読み込める。右の Outliner で切り替え、Export で1つのファイルにまとまる |
| Transform パネル | Blender と同じ Z-up の値。Ctrl+A（Apply Transform）で今の位置・向きを 0 にする |
| 保存されるもの | 消した粒を除き、原点・向き・大きさを焼き込んだファイル。元の精度と色（SH）はそのまま |

ブラウザは何も記憶しません。リロードすると、ファイルそのままの状態から始まります。

---

MIT ライセンス（[LICENSE](LICENSE)）。中身は [three.js](https://threejs.org/)・[Spark](https://github.com/sparkjsdev/spark)・[@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform)。
作る側のメモは [_dev/NOTES.md](_dev/NOTES.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md)。
