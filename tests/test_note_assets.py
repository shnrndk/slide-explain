import io
import json
import zipfile
import pytest
from PIL import Image
from backend.backups import create_backup, restore_backup, validate_archive
from backend.store import Store
from backend.note_assets import import_image, MAX_IMAGE_BYTES


def image_bytes():
    output=io.BytesIO();Image.new('RGB',(100,60),'green').save(output,format='PNG');return output.getvalue()


def upload(client, doc, slide, content=None, epoch=None, asset_id='a'*32):
    return client.post(f"/api/slides/{slide['id']}/note-assets",data={'epoch_id':epoch or doc['epoch'],'asset_id':asset_id},files={'file':('diagram.png',content if content is not None else image_bytes(),'image/png')})


def test_image_notes_and_history_survive_backup_restore(client, imported, tmp_path):
    _,doc=imported;slide=doc['slides'][0]
    asset=upload(client,doc,slide).json()
    assert asset['width']==100 and asset['height']==60
    response=client.get(asset['url']);assert response.status_code==200 and response.headers['content-type']=='image/png'
    Image.open(io.BytesIO(response.content)).verify()
    markdown=f"# My notes\n\n![Diagram]({asset['url']})\n\nhttps://youtu.be/dQw4w9WgXcQ\n\n```mermaid\nflowchart TD\nA-->B\n```"
    path=f"/api/slides/{slide['id']}/notes/personal"
    client.put(path,json={'body':markdown,'revision':0,'epoch':doc['epoch']}).raise_for_status()
    # The current note no longer contains the image, but history must keep it.
    client.put(path,json={'body':'New draft','revision':1,'epoch':doc['epoch']}).raise_for_status()
    archive=create_backup(client.app.state.store)
    with zipfile.ZipFile(archive) as z:
        assert f"assets/{doc['id']}/notes/{asset['id']}.png" in z.namelist()
        assert f"assets/{doc['id']}/original.pdf" in z.namelist()
    clean=Store(tmp_path/'restored');restore_backup(clean,archive)
    restored=Store(clean.root)
    assert restored.note(slide['id'],'personal')['body']=='New draft'
    assert markdown in [r['body'] for r in restored.rows('SELECT body FROM note_versions')]
    assert (restored.assets/doc['id']/'notes'/f"{asset['id']}.png").read_bytes()==response.content
    assert len(restored.rows('SELECT * FROM note_assets'))==1
    # Restoring an old note version uses the same durable image URL.
    previous=client.get(path+'/history').json()[-1]
    client.post(f"/api/versions/{previous['id']}/restore",json={'revision':2,'epoch':doc['epoch']}).raise_for_status()
    archive=create_backup(client.app.state.store)
    with zipfile.ZipFile(archive) as z:
        exported=z.read(f"exports/{doc['id']}/notes.md").decode()
        assert f"../../assets/{doc['id']}/notes/{asset['id']}.png" in exported
        assert '```mermaid' in exported and 'https://youtu.be/dQw4w9WgXcQ' in exported


def test_upload_is_idempotent_validated_and_does_not_overwrite_notes(client, imported):
    _,doc=imported;slide=doc['slides'][0]
    asset=upload(client,doc,slide).json()
    assert upload(client,doc,slide).json()==asset
    assert len(client.app.state.store.rows('SELECT * FROM note_assets'))==1
    assert client.app.state.store.note(slide['id'],'personal')['revision']==0
    assert upload(client,doc,doc['slides'][1]).status_code==400
    assert upload(client,doc,slide,asset_id='../escape').status_code==400
    assert upload(client,doc,slide,content=b'<svg onload="alert(1)"></svg>',asset_id='b'*32).status_code==400
    assert upload(client,doc,slide,content=b'corrupt PNG',asset_id='b'*32).status_code==400
    assert upload(client,doc,slide,epoch='stale',asset_id='b'*32).status_code==409
    assert client.get('/api/note-assets/unknown').status_code==404
    assets=client.get(f"/api/slides/{slide['id']}/note-assets",params={'epoch_id':doc['epoch']}).json()
    assert assets==[asset]
    assert not list(client.app.state.store.assets.rglob('*.tmp'))
    with pytest.raises(ValueError,match='15 MB'):
        import_image(client.app.state.store,slide['id'],'c'*32,'huge.png',b'x'*(MAX_IMAGE_BYTES+1))


def test_missing_image_stops_backup_and_incomplete_archive_cannot_restore(client, imported, tmp_path):
    _,doc=imported;slide=doc['slides'][0];asset=upload(client,doc,slide).json()
    archive=create_backup(client.app.state.store)
    asset_name=f"assets/{doc['id']}/notes/{asset['id']}.png"
    bad=tmp_path/'incomplete.zip'
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(bad,'w') as target:
        manifest=json.loads(source.read('manifest.json'));manifest['files'].pop(asset_name)
        for name in source.namelist():
            if name not in {asset_name,'manifest.json'}:target.writestr(name,source.read(name))
        target.writestr('manifest.json',json.dumps(manifest))
    with pytest.raises(ValueError,match='note image'):
        validate_archive(bad,tmp_path/'invalid')
    (client.app.state.store.assets/doc['id']/'notes'/f"{asset['id']}.png").unlink()
    with pytest.raises(ValueError,match='note image'):
        create_backup(client.app.state.store)
