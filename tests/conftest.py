import io
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from backend.app import create_app


def make_pdf(pages=2, encrypted=False):
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    titles = [
        "Concurrent Access to Shared Data",
        "Race Conditions",
        "The Critical Section",
    ]
    details = [
        [
            "Two threads access the same shared variable: Balance.",
            "Starting balance = 1000",
            "Thread A: Balance = Balance + 100",
            "Thread B: Balance = Balance - 200",
            "Expected final balance: 900",
            "Operations: LOAD -> MODIFY -> STORE",
        ],
        [
            "A race condition depends on the order of execution.",
            "Both threads may read 1000 before either writes.",
            "Thread A writes 1100. Thread B writes 800.",
            "Whichever thread writes last overwrites the other update.",
            "Solution: make the shared update atomic.",
        ],
        [
            "A critical section accesses or changes shared data.",
            "Only one thread should enter at a time.",
            "lock",
            "    Balance = Balance + 100",
            "unlock",
            "Mutual exclusion prevents conflicting updates.",
        ],
    ]
    for i in range(pages):
        w, h = (900, 600) if i % 2 == 0 else (600, 800)
        page = writer.add_blank_page(width=w, height=h)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
        )
        lines = [
            "0.98 0.98 0.95 rg",
            f"0 0 {w} {h} re f",
            "0.25 0.39 0.27 rg",
            f"BT /F1 27 Tf 45 {h - 95} Td ({titles[i % 3]}) Tj ET",
            "0.62 0.69 0.48 rg",
            f"45 {h - 122} {w - 90} 3 re f",
        ]
        for index, text in enumerate(details[i % 3]):
            lines += [
                "0.30 0.36 0.28 rg",
                f"BT /F1 16 Tf 45 {h - 172 - index * 44} Td ({text}) Tj ET",
            ]
        lines += [
            "0.5 0.57 0.45 rg",
            f"BT /F1 10 Tf 45 35 Td (Operating Systems - Study fixture | Slide {i + 1}) Tj ET",
        ]
        stream = DecodedStreamObject()
        stream.set_data(("\n".join(lines)).encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
    if encrypted:
        writer.encrypt("secret")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    app = create_app(tmp_path / "library", workers=False)
    with TestClient(app, headers={"X-Slide-Notes": "1"}) as client:
        yield client


@pytest.fixture
def imported(client):
    notebook = client.post("/api/notebooks", json={"name": "Operating Systems"}).json()
    response = client.post(
        f"/api/notebooks/{notebook['id']}/import",
        files={"file": ("lecture.pdf", make_pdf(), "application/pdf")},
    )
    assert response.status_code == 200, response.text
    doc = client.get(f"/api/documents/{response.json()['id']}").json()
    return notebook, doc
