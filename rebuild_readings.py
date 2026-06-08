# -*- coding: utf-8 -*-
"""
各キャストの個別ページ
  https://www.host2.jp/shop/<店舗id>/<slug>/index.html
に載っている公式ローマ字表記（<... class="kana">Ayumu Hojo</span>）を取得し、
ひらがなに変換して stores.json の `reading` を作り直す。

ポイント:
  - ローマ字は「名 姓」順（Ayumu Hojo）。日本語名は「姓 名」（鳳条 歩）なので
    トークンを反転して姓名順にしてから変換（Hojo Ayumu → ほうじょう あゆむ）。
  - ローマ字は長音（ほう/ゆう 等の伸ばし）を落とすため、素朴変換だと
    「ゆう→ゆ」のように現行の正しい読みより劣化する。そこで、現行 reading が
    「長音を除けばローマ字変換と同じ骨格」なら長音付きの現行を温存する。
  - 英語表記・変換不能・ローマ字なし等で生成できず、かつ現行 reading も無い人だけ
    reading_check:true を残す。
  - 画像は一切再取得しない（index.html のみ取得）。

使い方:
  python rebuild_readings.py --dry    # 変更内容を表示するだけ
  python rebuild_readings.py          # stores.json を書き換える
"""
import json, re, sys, time, urllib.request

BASE = "https://www.host2.jp/shop"
UA = {"User-Agent": "Mozilla/5.0"}
KANA_PAT = re.compile(r'class="kana">([^<]*)</span>')
CACHE_FILE = "_romaji_cache.json"

VOWELS = set("aeiou")

# Hepburn ローマ字 → ひらがな（長一致で引く）
TABLE = {
    # 拗音・特殊（3文字）
    "kya": "きゃ", "kyu": "きゅ", "kyo": "きょ",
    "sha": "しゃ", "shu": "しゅ", "sho": "しょ", "shi": "し",
    "cha": "ちゃ", "chu": "ちゅ", "cho": "ちょ", "chi": "ち",
    "tsu": "つ",
    "nya": "にゃ", "nyu": "にゅ", "nyo": "にょ",
    "hya": "ひゃ", "hyu": "ひゅ", "hyo": "ひょ",
    "mya": "みゃ", "myu": "みゅ", "myo": "みょ",
    "rya": "りゃ", "ryu": "りゅ", "ryo": "りょ",
    "gya": "ぎゃ", "gyu": "ぎゅ", "gyo": "ぎょ",
    "jya": "じゃ", "jyu": "じゅ", "jyo": "じょ",
    "bya": "びゃ", "byu": "びゅ", "byo": "びょ",
    "pya": "ぴゃ", "pyu": "ぴゅ", "pyo": "ぴょ",
    "che": "ちぇ", "she": "しぇ", "tsa": "つぁ", "tso": "つぉ",
    # 2文字
    "ka": "か", "ki": "き", "ku": "く", "ke": "け", "ko": "こ",
    "sa": "さ", "su": "す", "se": "せ", "so": "そ",
    "ta": "た", "te": "て", "to": "と",
    "na": "な", "ni": "に", "nu": "ぬ", "ne": "ね", "no": "の",
    "ha": "は", "hi": "ひ", "fu": "ふ", "he": "へ", "ho": "ほ",
    "ma": "ま", "mi": "み", "mu": "む", "me": "め", "mo": "も",
    "ya": "や", "yu": "ゆ", "yo": "よ",
    "ra": "ら", "ri": "り", "ru": "る", "re": "れ", "ro": "ろ",
    "wa": "わ", "wo": "を",
    "ga": "が", "gi": "ぎ", "gu": "ぐ", "ge": "げ", "go": "ご",
    "za": "ざ", "ji": "じ", "zi": "じ", "zu": "ず", "ze": "ぜ", "zo": "ぞ",
    "ja": "じゃ", "ju": "じゅ", "jo": "じょ",
    "da": "だ", "di": "ぢ", "du": "づ", "de": "で", "do": "ど",
    "ba": "ば", "bi": "び", "bu": "ぶ", "be": "べ", "bo": "ぼ",
    "pa": "ぱ", "pi": "ぴ", "pu": "ぷ", "pe": "ぺ", "po": "ぽ",
    "fa": "ふぁ", "fi": "ふぃ", "fe": "ふぇ", "fo": "ふぉ",
    "va": "ゔぁ", "vi": "ゔぃ", "vu": "ゔ", "ve": "ゔぇ", "vo": "ゔぉ",
    "je": "じぇ", "ti": "てぃ", "tu": "とぅ",
    # 1文字（母音）
    "a": "あ", "i": "い", "u": "う", "e": "え", "o": "お",
}


def romaji_to_hira(token):
    """1トークン（姓 or 名）をひらがなに。全部変換できたら ok=True。"""
    s = token.strip().lower()
    out = []
    ok = True
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ""
        # 促音（っ）: 子音の重なり。tch は っ＋ち。
        if c == "t" and s[i + 1:i + 3] == "ch":
            out.append("っ"); i += 1; continue
        if c not in VOWELS and c != "n" and c == nxt:
            out.append("っ"); i += 1; continue
        # 撥音（ん）: n の次が子音/語末/アポストロフィ
        if c == "n":
            if nxt == "'":
                out.append("ん"); i += 2; continue
            if nxt == "" or (nxt not in VOWELS and nxt != "y"):
                out.append("ん"); i += 1; continue
        matched = False
        for L in (3, 2, 1):
            seg = s[i:i + L]
            if seg in TABLE:
                out.append(TABLE[seg]); i += L; matched = True; break
        if not matched:
            ok = False; i += 1  # 不明文字（英語表記など）はスキップ
    return "".join(out), ok


def romaji_to_reading(romaji):
    """ローマ字（名 姓）→ 姓名順のひらがな reading。ok=全トークン変換成功。"""
    toks = [t for t in re.split(r"\s+", romaji.strip()) if t]
    if not toks:
        return "", False
    toks = list(reversed(toks))  # 名 姓 → 姓 名
    parts, ok_all = [], True
    for t in toks:
        h, ok = romaji_to_hira(t)
        if not h:
            ok = False
        parts.append(h)
        ok_all = ok_all and ok
    return " ".join(p for p in parts if p), ok_all


# 骨格比較用: 長音（伸ばしの う/お）を畳んで比較する
O_SOUNDS = set("おこそとのほもよろをごぞどぼぽょ")
U_SOUNDS = set("うくすつぬふむゆるぐずづぶぷゅ")


def skeleton(kana):
    """長音や正書法差（づ/ず, ぢ/じ, にゃ/んや）を畳んだ比較用キー。
    ローマ字は これらを区別できないので、現行 reading が「同じ発音」なら
    現行（伝統的・長音付き）を温存するために使う。"""
    res = []
    for ch in kana:
        if ch in " 　ー":
            continue
        if res:
            p = res[-1]
            if ch == "う" and (p in O_SOUNDS or p in U_SOUNDS):
                continue
            if ch == "お" and p in O_SOUNDS:
                continue
        res.append(ch)
    s = "".join(res)
    s = s.replace("づ", "ず").replace("ぢ", "じ")          # 連濁の四つ仮名差を無視
    s = s.replace("にゃ", "んや").replace("にゅ", "んゆ").replace("にょ", "んよ")  # n+y の曖昧さ
    for a, b in (("ぁ", "あ"), ("ぃ", "い"), ("ぅ", "う"), ("ぇ", "え"), ("ぉ", "お")):
        s = s.replace(a, b)                               # 小書き母音（ローマ字で表せない）
    return s


def fetch_romaji(sid, slug, cache):
    key = f"{sid}/{slug}"
    if key in cache:
        return cache[key]
    url = f"{BASE}/{sid}/{slug}/index.html"
    romaji = ""
    try:
        html = urllib.request.urlopen(
            urllib.request.Request(url, headers=UA), timeout=20
        ).read().decode("utf-8", "ignore")
        m = KANA_PAT.search(html)
        if m:
            romaji = m.group(1).strip()
    except Exception as e:
        romaji = ""
        print(f"  [fetch NG] {key}: {e}")
    cache[key] = romaji
    time.sleep(0.12)
    return romaji


def main():
    dry = "--dry" in sys.argv
    sys.stdout.reconfigure(encoding="utf-8")
    data = json.load(open("stores.json", encoding="utf-8"))
    try:
        cache = json.load(open(CACHE_FILE, encoding="utf-8"))
    except Exception:
        cache = {}

    changed = same = kept_existing = checks = 0
    for store in data["stores"]:
        sid = store["id"]
        for p in store["staff"]:
            slug = p["id"]
            old = p.get("reading", "")
            romaji = fetch_romaji(sid, slug, cache)
            cand, ok = romaji_to_reading(romaji)

            final = None
            check = False
            if cand and ok:
                # ローマ字から綺麗に生成できた。
                # 現行が「長音/正書法差を除けば同じ」なら現行（長音付き）を温存。
                ct = cand.split(" ")
                ot = old.split() if old else []
                sk_old, sk_cand = skeleton(old), skeleton(cand)
                if not old:
                    final = cand
                elif sk_old == sk_cand:
                    final = old
                elif len(ot) == len(ct):
                    # トークン（姓・名）ごとに、骨格一致なら現行を採用
                    merged = [o if skeleton(o) == skeleton(c) else c
                              for o, c in zip(ot, ct)]
                    final = old if merged == ot else " ".join(merged)
                elif sk_cand and sk_cand in sk_old:
                    final = old   # ローマ字が芸名の一部のみ＝現行のほうが完全
                else:
                    final = cand  # ローマ字のほうが完全 or 読みが別物
                if final == old:
                    kept_existing += 1
            else:
                # 生成不可（英語表記・ローマ字なし等）。現行があれば温存。
                if old:
                    final = old
                else:
                    final = cand  # 取れた範囲（空のことも）
                    check = True
                    checks += 1

            note = ""
            if final != old:
                changed += 1
                note = f"  *** {old!r} -> {final!r}"
            else:
                same += 1
            if check:
                note += "  [reading_check]"
            print(f"[{romaji or '-':<22}] {p['name']}: {final}{note}")

            p["reading"] = final
            if check:
                p["reading_check"] = True
            else:
                p.pop("reading_check", None)

    json.dump(cache, open(CACHE_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\n変更 {changed} / 据置 {same} / うち長音温存 {kept_existing} / reading_check {checks}")
    if dry:
        print("（--dry のため stores.json は書き換えていません）")
    else:
        with open("stores.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("stores.json を更新しました。")


if __name__ == "__main__":
    main()
