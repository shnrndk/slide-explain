import io
import json
import zipfile
import pytest
from pypdf import PdfReader, PdfWriter
from PIL import Image
from backend.store import Store
from backend.backups import create_backup, restore_backup
from conftest import make_pdf


def layer(client, doc, slide):
    response = client.get(f"/api/slides/{slide['id']}/text-layer", params={'epoch_id':doc['epoch']})
    response.raise_for_status()
    return response.json()


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_selectable_text_follows_page_rotation_and_crop(client, rotation):
    pdf = PdfReader(io.BytesIO(make_pdf(1)))
    page = pdf.pages[0]
    page.cropbox.lower_left = (20, 20)
    page.cropbox.upper_right = (880, 580)
    page.rotate(rotation)
    writer = PdfWriter(); writer.add_page(page)
    output = io.BytesIO(); writer.write(output)
    notebook = client.post('/api/notebooks', json={'name':'Rotated'}).json()
    imported = client.post(f"/api/notebooks/{notebook['id']}/import", files={'file':('rotated.pdf', output.getvalue())}).json()
    doc = client.get(f"/api/documents/{imported['id']}").json()
    data = layer(client, doc, doc['slides'][0])
    assert data['selectable'] and 'Concurrent Access' in data['text']
    assert ''.join(c['text'] for c in data['characters']) == data['text']
    boxes = [c['box'] for c in data['characters'] if c['box']]
    assert all(0 <= x < x+w <= 1.000001 and 0 <= y < y+h <= 1.000001 for x,y,w,h in boxes)
    title_start = data['text'].index('Concurrent Access')
    first = next(c['box'] for c in data['characters'] if c['start']==title_start)
    # Native page rotation changes the first title character's display corner.
    if rotation == 0: assert first[0] < .1 and first[1] < .2
    if rotation == 90: assert first[0] > .75 and first[1] < .1
    if rotation == 180: assert first[0] > .8 and first[1] > .75
    if rotation == 270: assert first[0] < .2 and first[1] > .8


def test_pdf_marks_save_clear_and_survive_clean_backup_restore(client, imported, tmp_path):
    _, doc = imported; slide = doc['slides'][0]
    data = layer(client, doc, slide)
    path = f"/api/slides/{slide['id']}/pdf-annotations"
    start = data['text'].index('Concurrent Access'); quote = 'Concurrent Access'
    mark = {'start':start, 'end':start+len(quote), 'quote':quote, 'text_hash':data['text_hash'], 'epoch':doc['epoch'], 'style':'highlight', 'color':'blue'}
    client.post(path,json=mark).raise_for_status()
    client.post(path,json={**mark,'style':'underline'}).raise_for_status()
    # Repeat clicks replace that style only; a highlight and underline coexist.
    result = client.post(path,json={**mark,'color':'pink'}).json()
    assert len(result)==2 and {m['style'] for m in result}=={'highlight','underline'}
    assert layer(client, doc, slide)==data
    store=client.app.state.store
    assert store.note(slide['id'],'personal')['body']==''
    assert store.note(slide['id'],'explanation')['body']==''
    archive=create_backup(store)
    with zipfile.ZipFile(archive) as z:
        assert f"assets/{doc['id']}/original.pdf" in z.namelist()
        assert 'PDF highlight (pink)' in z.read(f"exports/{doc['id']}/notes.md").decode()
    clean=Store(tmp_path/'restored');restore_backup(clean,archive)
    assert len(clean.rows('SELECT * FROM pdf_annotations'))==2
    assert clean.one('SELECT text FROM pdf_text_layers')['text']==data['text']
    restarted=Store(clean.root)
    assert len(restarted.rows('SELECT * FROM pdf_annotations'))==2
    client.post(path,json={**mark,'action':'clear'}).raise_for_status()
    assert client.get(path,params={'epoch_id':doc['epoch']}).json()==[]
    # Different pages have different immutable text hashes.
    other=doc['slides'][1]
    assert layer(client,doc,other)['text_hash']!=data['text_hash']
    assert client.get(f"/api/slides/{other['id']}/pdf-annotations",params={'epoch_id':doc['epoch']}).json()==[]


def test_pdf_mark_guards_and_scanned_pages(client, imported):
    _,doc=imported;slide=doc['slides'][0];data=layer(client,doc,slide)
    path=f"/api/slides/{slide['id']}/pdf-annotations"
    mark={'start':0,'end':10,'quote':data['text'][:10],'text_hash':data['text_hash'],'epoch':doc['epoch']}
    assert client.post(path,json={**mark,'quote':'wrong text'}).status_code==400
    assert client.post(path,json={**mark,'text_hash':'0'*64}).status_code==409
    assert client.post(path,json={**mark,'epoch':'stale'}).status_code==409
    assert client.post(path,json={**mark,'color':'red'}).status_code==422
    assert client.post(path,json={**mark,'end':2_000_000}).status_code==400
    image=Image.new('RGB',(200,300),'white');output=io.BytesIO();image.save(output,format='PDF')
    imported=client.post(f"/api/notebooks/{doc['notebook_id']}/import",files={'file':('scan.pdf',output.getvalue())}).json()
    scanned=client.get(f"/api/documents/{imported['id']}").json()
    assert not layer(client,scanned,scanned['slides'][0])['selectable']


def test_pdf_mark_utf16_boundaries(client, imported):
    _,doc=imported;slide=doc['slides'][0]
    layer(client,doc,slide)
    characters=[{'text':'🧠','start':0,'end':2,'box':[0,.1,.1,.1]},{'text':'X','start':2,'end':3,'box':[.1,.1,.1,.1]}]
    with client.app.state.store.connect() as db:
        db.execute('UPDATE pdf_text_layers SET text=?,characters=? WHERE slide_id=?',('🧠X',json.dumps(characters),slide['id']))
    data=layer(client,doc,slide)
    path=f"/api/slides/{slide['id']}/pdf-annotations"
    mark={'start':0,'end':2,'quote':'🧠','text_hash':data['text_hash'],'epoch':doc['epoch']}
    client.post(path,json=mark).raise_for_status()
    assert client.post(path,json={**mark,'end':1}).status_code==400
