"""Durable image attachments kept with the document, including note history."""
import io
import re
import warnings
from pathlib import Path
from PIL import Image, ImageOps, UnidentifiedImageError
from .store import durable_write, now, sha256

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_PIXELS = 20_000_000


def attachment_path(store, asset):
    if not re.fullmatch(r'[a-f0-9]{32}', asset['id']) or not re.fullmatch(r'[a-f0-9]{32}', asset['document_id']):
        raise ValueError('Invalid note attachment.')
    return store.assets / asset['document_id'] / 'notes' / f"{asset['id']}.png"


def import_image(store, slide_id, asset_id, filename, content):
    if not re.fullmatch(r'[a-f0-9]{32}', asset_id):
        raise ValueError('Invalid image upload identifier.')
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError('Choose an image of 15 MB or smaller.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as original:
                if original.format not in {'PNG', 'JPEG', 'WEBP', 'GIF'}:
                    raise ValueError('Choose a PNG, JPEG, WebP or GIF image. Export other diagrams as an image first.')
                if original.width * original.height > MAX_PIXELS:
                    raise ValueError('Choose an image with at most 20 million pixels.')
                # Decode, orient and normalize. Do not keep executable formats or metadata.
                image = ImageOps.exif_transpose(original).convert('RGBA')
                output = io.BytesIO()
                image.save(output, format='PNG')
                width, height = image.size
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('This image could not be read. Choose a valid PNG, JPEG, WebP or GIF.') from exc
    data = output.getvalue()
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError('The decoded image is too large. Resize it and try again.')
    with store.lock:
        slide = store.one('SELECT * FROM slides WHERE id=?', (slide_id,))
        if not slide:
            raise KeyError(slide_id)
        existing = store.one('SELECT * FROM note_assets WHERE id=?', (asset_id,))
        if existing:
            import hashlib
            if existing['slide_id'] != slide_id or existing['sha256'] != hashlib.sha256(data).hexdigest():
                raise ValueError('This upload identifier already belongs to another image.')
            return existing
        asset = {'id':asset_id, 'document_id':slide['document_id']}
        path = attachment_path(store, asset)
        path.parent.mkdir(exist_ok=True)
        try:
            durable_write(path, data)
            with store.connect() as db:
                db.execute('INSERT INTO note_assets VALUES (?,?,?,?,?,?,?,?)',
                    (asset_id, slide_id, slide['document_id'], Path(filename).name[:200], sha256(path), width, height, now()))
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return store.one('SELECT * FROM note_assets WHERE id=?', (asset_id,))
