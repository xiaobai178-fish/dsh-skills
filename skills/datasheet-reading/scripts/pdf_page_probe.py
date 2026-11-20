#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pdf_page_probe.py — 探测 PDF 页面是"文本型"还是"图像型"，并输出统计与样例

用法: python pdf_page_probe.py <in.pdf> [--pages 19-21]
输出: 每页 词数 / CJK 词数 / 图片数 / 矢量绘制数 / 文本前 200 字
判定: 词数很少但图片数>0 → 图像型（需 OCR/视觉）；矢量绘制很多但词少 → 曲线绘制（也需视觉）
"""
import sys
import argparse

try:
    import pymupdf as fitz
except ImportError:
    import fitz


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--pages")
    a = ap.parse_args()

    doc = fitz.open(a.pdf)
    pages = range(doc.page_count)
    if a.pages:
        if "-" in a.pages:
            s, e = a.pages.split("-")
            pages = range(max(0, int(s) - 1), min(doc.page_count, int(e)))
        else:
            pages = [int(x) - 1 for x in a.pages.split(",")]

    for pno in pages:
        pg = doc[pno]
        words = pg.get_text("words")
        cjk = sum(1 for w in words if any("\u4e00" <= ch <= "\u9fff" for ch in w[4]))
        imgs = pg.get_images(full=True)
        try:
            drawings = len(pg.get_drawings())
        except Exception:
            drawings = -1
        text = pg.get_text("text").replace("\n", " ")[:200]
        kind = "文本型"
        if len(words) < 60 and (len(imgs) > 0 or drawings > 200):
            kind = "图像/矢量型（需视觉或 OCR）"
        print("PAGE %d | words=%d cjk=%d images=%d drawings=%d | %s" % (pno + 1, len(words), cjk, len(imgs), drawings, kind))
        print("    text: %s" % text)
    doc.close()


if __name__ == "__main__":
    main()
