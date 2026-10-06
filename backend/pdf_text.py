"""Selectable character positions in the same PDFium coordinates as page images."""
from contextlib import closing
import ctypes
import hashlib
import json
import math
import pypdfium2 as pdfium
import pypdfium2.raw as raw
from .importer import PDF_LOCK


def text_layer(store, slide):
    # Caller holds the store maintenance lock; PDFium is process-wide thread unsafe.
    cached = store.one("SELECT * FROM pdf_text_layers WHERE slide_id=?", (slide['id'],))
    if cached:
        text, characters = cached['text'], json.loads(cached['characters'])
    else:
        characters, parts, offset = [], [], 0
        with PDF_LOCK, closing(pdfium.PdfDocument(store.assets / slide['document_id'] / 'original.pdf')) as pdf:
            with closing(pdf[slide['page_number'] - 1]) as page, closing(page.get_textpage()) as textpage:
                if textpage.count_chars() > 100_000:
                    raise ValueError('This page has too much text for selection. The page image remains available.')
                width, height = slide['width'] * 10, slide['height'] * 10

                def point(x, y):
                    dx, dy = ctypes.c_int(), ctypes.c_int()
                    if not raw.FPDF_PageToDevice(page, 0, 0, width, height, 0, x, y, dx, dy):
                        raise ValueError('Could not align this PDF text layer.')
                    return dx.value / width, dy.value / height

                for index in range(textpage.count_chars()):
                    code = raw.FPDFText_GetUnicode(textpage, index)
                    if not code or code > 0x10ffff or 0xd800 <= code <= 0xdfff:
                        continue
                    char = chr(code)
                    length = len(char.encode('utf-16-le')) // 2
                    box = None
                    if char not in '\r\n\t':
                        try:
                            l, b, r, t = textpage.get_charbox(index, loose=True)
                            points = [point(x, y) for x in (l, r) for y in (b, t)]
                            if all(math.isfinite(v) for p in points for v in p):
                                x, y = max(0, min(p[0] for p in points)), max(0, min(p[1] for p in points))
                                right, bottom = min(1, max(p[0] for p in points)), min(1, max(p[1] for p in points))
                                if right > x and bottom > y:
                                    box = [x, y, right-x, bottom-y]
                        except pdfium.PdfiumError:
                            pass
                    angle = (page.get_rotation() - math.degrees(raw.FPDFText_GetCharAngle(textpage, index))) % 360
                    characters.append({'text':char, 'start':offset, 'end':offset+length, 'box':box, 'angle':angle})
                    parts.append(char)
                    offset += length
        text = ''.join(parts)
        with store.connect() as db:
            db.execute('INSERT INTO pdf_text_layers VALUES (?,?,?)', (slide['id'], text, json.dumps(characters)))
    return {'text':text, 'text_hash':hashlib.sha256(text.encode()).hexdigest(), 'characters':characters,
            'selectable':any(c['box'] and c['text'].strip() for c in characters)}
