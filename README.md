# 名簿

職場や施設ごとに人物を登録し、あだ名・タグ・色で整理できる名簿アプリ（PWA）。データは端末内（IndexedDB）にだけ保存されます。

## 公開手順（GitHub Pages）

1. このフォルダの中身をリポジトリに置く（ルートでも `meibo/` のようなサブフォルダでも可。パスはすべて相対）。
2. リポジトリの Settings → Pages で公開元のブランチを選ぶ。
3. 公開URLを iPhone の Safari で開き、共有ボタン →「ホーム画面に追加」。Android は Chrome のメニュー →「ホーム画面に追加」。

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面の骨組み |
| `style.css` | 見た目（ライト/ダーク自動切替、reduced-motion 対応） |
| `app.js` | ロジック一式（保存、検索、絞り込み、並び替え、シート、ドラッグ） |
| `sw.js` | オフライン対応（stale-while-revalidate 方式） |
| `manifest.json` | ホーム画面追加用の設定 |
| `icons/` | アイコン |

## データ形式

「設定 → JSONで書き出す」で保存されるファイルの中身です。別端末へは「JSONを読み込む」で移せます。

```json
{
  "people": [{ "id": "…", "name": "田中 花子", "kana": "たなか はなこ", "aliases": ["はなちゃん"],
               "placeIds": ["…"], "tagIds": ["…"], "color": "pink",
               "birthday": { "year": 1985, "month": 9, "day": 13 }, "note": "…", "order": 0 }],
  "places": [{ "id": "…", "name": "職場" }],
  "tags":   [{ "id": "…", "name": "女性" }]
}
```
