#!/usr/bin/env python3
"""fidelity_diff.py — deterministic candidates for semantic drift in Japanese rewrites.

Adapted from nanaism/yomiyasu's yomiyasu_diff.py:
https://github.com/nanaism/yomiyasu

This tool does not decide whether meaning changed. It only surfaces lexical,
modal, sentence-ending, connective, and structural changes that deserve review.
See ../UPSTREAM.md and ../LICENSE.yomiyasu for provenance and license details.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


MARKERS: dict[str, str] = {
    "依頼": r"(?:て|で)ください",
    "勧誘": r"ましょう",
    "義務": r"なければ(?:なりません|ならない)|なくては(?:なりません|ならない)|ねばならない|必要があ(?:ります|る)|べき",
    "評価": r"大切|重要|大事|不可欠|欠かせ|肝心|肝要",
    "可能": r"でき(?:ます|る|ません|ない)|可能性|可能(?:です|だ|になる)",
    "推量": r"でしょう|だろう|かもしれ|はず|と思(?:います|う)|ようです|らしい|おそれ",
    "念押し": r"のです|んです|こそ|まさに|必ず|絶対|常に",
    "意志": r"(?:に|ように|ことに)し(?:ます|ている|ています)",
    "条件": r"(?<!例)(?<!たと)(?:れ|え|け|せ|て|ね|め|べ)ば(?![かり])|なら(?=[、。]|$|\s)|たら(?=[、。]|$|\s)|場合",
    "説明化": r"ことが挙げられ|ということ|ことです|ことになります",
    "つなぎ": r"まず|また(?!は)|そして|さらに|次に|最後に|ただし|しかし|つまり|そのため|ので(?!す)|によって|ことで|ことにより",
}

CONTENT_RE = re.compile(r"[一-龥々〆ヵヶ]{2,}|[ァ-ヴー]{2,}|[A-Za-z][A-Za-z0-9_.+#/-]+")
LIST_RE = re.compile(r"(?m)^\s*(?:[*+-]|・|\d+[.)])\s+\S")
HEADING_RE = re.compile(r"(?m)^\s*#{1,6}\s+")
LIST_PREFIX_RE = re.compile(r"(?m)^\s*(?:[*+-]|・|\d+[.)])\s+")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?])|\n+")

# Advisory-only detector for changes in explicit negative expressions.
NEGATION_RE = re.compile(r"ません(?:でした)?|な(?:い|かった|く)(?![ぁ-ん])|ず(?=に|[、。！？!?\s]|$)")

LOGIC_PATTERNS = [
    ("文頭のつなぎ", re.compile(r"^(?:ただし|しかし|一方|また|さらに|つまり|そのため|したがって|だから|それでも|なお|そこで|ところが)")),
    ("主題の「も」", re.compile(r"^(?!それで)[^、。]{0,17}[^、。てでり]も、")),
    ("予告だけの文", re.compile(r"^.{0,28}(?:が|も)あります。$|次の(?:点|こと|とおり|通り)です|以下の(?:点|こと|とおり|通り)")),
    ("文頭の指示語", re.compile(r"^(?:これ|それ(?!でも|から)|こう(?:した|して|する|いう)|そう(?:した|して|する|いう)|この|その)(?!して)")),
]


def normalize(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = LIST_PREFIX_RE.sub("", text)
    text = HEADING_RE.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE_SPLIT_RE.split(normalize(text)) if s.strip()]


def paragraphs(text: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            if current:
                blocks.append("\n".join(current))
                current = []
            continue
        current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def marker_counts(text: str) -> dict[str, int]:
    normalized = normalize(text)
    return {name: len(re.findall(pattern, normalized)) for name, pattern in MARKERS.items()}


def ending_kind(sentence: str) -> str:
    text = re.sub(r"[\s*_]+$", "", sentence.strip())
    text = re.sub(r"[。．.!！?？」』）)]+$", "", text).strip()
    if not text:
        return ""
    if re.search(r"(?:て|で)ください(?:ね)?$", text):
        return "依頼"
    if re.search(r"ましょう$|とよいです$|といいです$|をおすすめします$|をお勧めします$", text):
        return "勧誘"
    if re.search(r"なければ(?:なりません|ならない)$|なくては(?:なりません|ならない)$|必要があ(?:ります|る)$|べき(?:です|だ)?$", text):
        return "義務"
    if re.search(r"(?:でしょう|だろう|かもしれません|かもしれない|と思います|と思う|はずです|はずだ|ようです|らしい)$", text):
        return "推量"
    if re.search(r"可能性があ(?:ります|る)$|(?:でき|可能)(?:ます|る|です|だ)$", text):
        return "可能"
    if re.search(r"(?:大切|重要|大事|不可欠|肝心|肝要)(?:です|でした|だ|である)?$", text):
        return "評価"
    if re.search(r"予定(?:です|だ)$", text):
        return "予定"
    if re.search(r"(?:ました|でした|ませんでした)$", text):
        return "過去"
    if re.search(r"(?:ています|ている|でいます|でいる)$", text):
        return "継続・状態"
    if re.search(r"(?:ます|ません)$", text):
        return "動作・説明"
    if re.search(r"(?:です|だ|である|ではない|でない)$", text):
        return "断定"
    return "その他"


def ending_summary(text: str) -> dict[str, Any]:
    rows = [{"sentence": s, "kind": ending_kind(s)} for s in sentences(text)]
    counts = Counter(row["kind"] for row in rows if row["kind"])
    return {"rows": rows, "counts": dict(counts)}


def ending_changes(original: str, rewrite: str) -> list[dict[str, Any]]:
    before = ending_summary(original)["rows"]
    after = ending_summary(rewrite)["rows"]
    changes: list[dict[str, Any]] = []
    for index in range(min(len(before), len(after))):
        left, right = before[index], after[index]
        if left["kind"] != right["kind"]:
            changes.append(
                {
                    "index": index + 1,
                    "original_kind": left["kind"],
                    "rewrite_kind": right["kind"],
                    "original": left["sentence"],
                    "rewrite": right["sentence"],
                }
            )
    return changes


def negation_changes(original: str, rewrite: str) -> list[dict[str, int]]:
    """Compare negative-expression counts at aligned sentence positions."""
    before = [len(NEGATION_RE.findall(s)) for s in sentences(original)]
    after = [len(NEGATION_RE.findall(s)) for s in sentences(rewrite)]
    changes = []
    for index in range(max(len(before), len(after))):
        left = before[index] if index < len(before) else 0
        right = after[index] if index < len(after) else 0
        if left != right:
            changes.append({"index": index + 1, "original": left, "rewrite": right})
    return changes


def logic_points(text: str) -> list[dict[str, str]]:
    points: list[dict[str, str]] = []
    for sentence in sentences(text):
        for kind, pattern in LOGIC_PATTERNS:
            if pattern.search(sentence):
                points.append({"kind": kind, "sentence": sentence})
    return points


def content_words(text: str) -> set[str]:
    return set(CONTENT_RE.findall(normalize(text)))


def diff(original: str, rewrite: str) -> dict[str, Any]:
    original_markers = marker_counts(original)
    rewrite_markers = marker_counts(rewrite)
    markers = [
        {"kind": kind, "original": original_markers[kind], "rewrite": rewrite_markers[kind]}
        for kind in MARKERS
        if original_markers[kind] != rewrite_markers[kind]
    ]

    original_words = content_words(original)
    rewrite_words = content_words(rewrite)

    structure: list[str] = []
    if LIST_RE.search(original) and not LIST_RE.search(rewrite):
        structure.append("箇条書きが地の文へ変わった")

    original_paragraphs = len(paragraphs(original))
    rewrite_paragraphs = len(paragraphs(rewrite))
    if original_paragraphs != rewrite_paragraphs:
        structure.append(f"段落数が変わった（{original_paragraphs} → {rewrite_paragraphs}）")

    original_sentences = len(sentences(original))
    rewrite_sentences = len(sentences(rewrite))
    if original_sentences != rewrite_sentences:
        structure.append(f"文数が変わった（{original_sentences} → {rewrite_sentences}）")

    original_endings = ending_summary(original)
    rewrite_endings = ending_summary(rewrite)

    return {
        "markers": markers,
        "negation": negation_changes(original, rewrite),
        "new_words": sorted(rewrite_words - original_words),
        "lost_words": sorted(original_words - rewrite_words),
        "structure": structure,
        "logic": logic_points(rewrite),
        "endings": {
            "original_counts": original_endings["counts"],
            "rewrite_counts": rewrite_endings["counts"],
            "changes": ending_changes(original, rewrite),
            "alignment": "sentence-position",
        },
    }


def render_report(data: dict[str, Any]) -> str:
    lines: list[str] = []
    if data["markers"]:
        lines.append("■ 言い回し・モダリティの増減")
        for item in data["markers"]:
            lines.append(f"- {item['kind']}: {item['original']} → {item['rewrite']}")

    if data["negation"]:
        lines.append("■ 否定表現の増減（原文との照合候補）")
        for item in data["negation"]:
            lines.append(f"- #{item['index']}: {item['original']} → {item['rewrite']}")

    if data["new_words"]:
        lines.append("■ 元文にない語: " + "、".join(data["new_words"]))
    if data["lost_words"]:
        lines.append("■ 消えた語: " + "、".join(data["lost_words"]))

    for item in data["structure"]:
        lines.append("■ " + item)

    if data["endings"]["changes"]:
        lines.append("■ 文末種別が変わった候補")
        for item in data["endings"]["changes"]:
            lines.append(
                f"- #{item['index']} {item['original_kind']} → {item['rewrite_kind']}: "
                f"{item['rewrite'][:60]}"
            )

    if data["logic"]:
        lines.append("■ 接続・指示関係を確認する候補")
        for item in data["logic"]:
            lines.append(f"- {item['kind']}: {item['sentence'][:60]}")

    return "\n".join(lines) if lines else "（候補なし）"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare original and rewritten Japanese text for semantic-fidelity review candidates."
    )
    parser.add_argument("original", type=Path)
    parser.add_argument("rewrite", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    original = args.original.read_text(encoding="utf-8")
    rewrite = args.rewrite.read_text(encoding="utf-8")
    data = diff(original, rewrite)
    if args.as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(render_report(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
