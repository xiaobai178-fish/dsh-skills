#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pdf-extract.py — 用 PyMuPDF 抽取 PDF 文本/坐标（支持中文 ToUnicode / CID 字体）

用法:
  python pdf-extract.py <in.pdf> --out items.csv [--pages 1-20] [--mode words|text]
输出 CSV: page,x,y,w,h,text        （x,y 为左上角坐标，y 向下增大）
也可 --find 关键词 直接打印上下文行。
"""
import argparse
import csv
import sys

try:
    import pymupdf as fitz
except ImportError:
    import fitz  # 旧版包名


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out")
    ap.add_argument("--pages", help="如 1-20 或 3,5,9")
    ap.add_argument("--mode", default="words", choices=["words", "text"])
    ap.add_argument("--find")
    ap.add_argument("--rows", type=int, default=4)
    args = ap.parse_args()

    doc = fitz.open(args.pdf)
    pages = range(doc.page_count)
    if args.pages:
        if "-" in args.pages:
            a, b = args.pages.split("-")
            pages = range(max(0, int(a) - 1), min(doc.page_count, int(b)))
        else:
            pages = [int(p) - 1 for p in args.pages.split(",")]

    rows = []
    full = []
    for pno in pages:
        page = doc[pno]
        if args.mode == "words":
            for w in page.get_text("words"):
                x0, y0, x1, y1, word = w[0], w[1], w[2], w[3], w[4]
                if word.strip():
                    rows.append((pno + 1, round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2), word))
        else:
            full.append((pno + 1, page.get_text("text")))

    if args.out:
        with open(args.out, "w", encoding="utf-8-sig", newline="") as f:
            if args.mode == "words":
                w = csv.writer(f)
                w.writerow(["page", "x", "y", "w", "h", "text"])
                for r in rows:
                    w.writerow(r)
            else:
                w = csv.writer(f)
                w.writerow(["page", "text"])
                for r in full:
                    w.writerow(r)
        print(f"已写 {args.out}（{len(rows) if args.mode=='words' else len(full)} 条）")

    if args.find:
        if args.mode == "words":
            # 按页 + y 聚行
            by = {}
            for (pg, x, y, w_, h, t) in rows:
                by.setdefault((pg, round(y / 3)), []).append((x, t))
            for (pg, _), items in sorted(by.items()):
                line = " ".join(t for _, t in sorted(items))
                if args.find in line:
                    print(f"p{pg}: {line[:200]}")
        else:
            for pg, txt in full:
                for line in txt.splitlines():
                    if args.find in line:
                        print(f"p{pg}: {line.strip()[:200]}")

    doc.close()


if __name__ == "__main__":
    main()
