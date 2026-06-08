# -*- coding: utf-8 -*-
"""
写真一括ダウンロード スクリプト (v2: 1人＝複数枚対応)

各キャストの個別ページ
  https://www.host2.jp/shop/<店舗id>/<slug>/index.html
には最大4枚ほどの写真が載っている。実際のファイル名は:
  - pr01.jpg            … プロフィール（メイン）
  - pic01.jpg, pic02.jpg, pic03.jpg ... … ギャラリー
  - *-m.jpg は同じ写真のサムネ版なので除外
このスクリプトは各ページをパースして「実在する full-size jpg」を全部取得し、
  images/<店舗id>/<slug>/<ファイル名>
に保存する。あわせて stores.json の各人の `photo`(単数) を
  `photos`: ["<slug>/pr01.jpg", "<slug>/pic01.jpg", ...]
という配列に書き換える（他のフィールドと並び順は維持）。

使い方:
  python download_images.py
"""
import json, os, re, time, urllib.request, urllib.error

BASE = "https://www.host2.jp/shop"
UA = {"User-Agent": "Mozilla/5.0"}


def fetch_page_images(sid, slug):
    """個別ページをパースして full-size jpg のファイル名一覧を返す。
    取れなければ pr01/pic01..pic05 を直接プローブする。"""
    url = f"{BASE}/{sid}/{slug}/index.html"
    names = []
    try:
        req = urllib.request.Request(url, headers=UA)
        html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
        pat = re.compile(rf"shop/{sid}/{slug}/([\w\-]+)\.jpg")
        found = set()
        for m in pat.findall(html):
            if m.endswith("-m") or m.endswith("-thum"):
                continue
            found.add(m + ".jpg")
        names = sorted(found, key=sort_key)
    except Exception:
        names = []
    if not names:  # フォールバック：直接プローブ
        for cand in ["pr01.jpg", "pic01.jpg", "pic02.jpg", "pic03.jpg",
                     "pic04.jpg", "pic05.jpg"]:
            if url_exists(f"{BASE}/{sid}/{slug}/{cand}"):
                names.append(cand)
    return names


def sort_key(name):
    # pr01 を先頭、その後 pic01, pic02 ... の順に
    return (0, name) if name.startswith("pr") else (1, name)


def url_exists(url):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:
            return len(r.read()) >= 500
    except Exception:
        return False


def download(url, dest):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read()
    if len(data) < 500:
        raise ValueError("too small")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)


def rebuild_person(p, photos):
    """photo(単数) を photos(配列) に置き換えた新しい dict を、
    元のキー順を保ったまま返す。"""
    out = {}
    for k, v in p.items():
        if k == "photo":
            out["photos"] = photos
        else:
            out[k] = v
    if "photos" not in out:  # 元に photo が無かった場合は末尾に
        out["photos"] = photos
    return out


def main():
    data = json.load(open("stores.json", encoding="utf-8"))
    total_imgs = ng_people = skip = 0

    for store in data["stores"]:
        sid = store["id"]
        new_staff = []
        for p in store["staff"]:
            slug = p["id"]
            if not p.get("has_photo", True):
                print(f"[skip] {store['name']} {p['name']}（写真未設定）")
                new_staff.append(rebuild_person(p, []))
                skip += 1
                continue

            names = fetch_page_images(sid, slug)
            photos = []
            for fname in names:
                rel = f"{slug}/{fname}"                      # stores.json に入れる相対パス
                dest = os.path.join("images", sid, slug, fname)
                if os.path.exists(dest):
                    photos.append(rel)
                    total_imgs += 1
                    continue
                try:
                    download(f"{BASE}/{sid}/{slug}/{fname}", dest)
                    photos.append(rel)
                    total_imgs += 1
                    print(f"[ok] {rel}")
                except Exception as e:
                    print(f"[NG] {rel} … {e}")
                time.sleep(0.15)

            if not photos:
                print(f"[NG] {store['name']} {p['name']} ({slug}) … 1枚も取得できず")
                ng_people += 1
            else:
                print(f"  -> {store['name']} {p['name']}: {len(photos)}枚")
            new_staff.append(rebuild_person(p, photos))
        store["staff"] = new_staff

    # stores.json を書き戻し（日本語そのまま・整形）
    with open("stores.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n完了: 画像 {total_imgs}枚 / 1枚も取れず {ng_people}人 / スキップ(写真なし) {skip}人")
    print("stores.json を photos(配列) 形式に更新しました。")


if __name__ == "__main__":
    main()
