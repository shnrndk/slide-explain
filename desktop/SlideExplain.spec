# Only explicitly listed runtime assets enter the app: never .env or user data.
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = Path(SPECPATH).parent
analysis = Analysis(
    [str(root / 'desktop/main.py')], pathex=[str(root)],
    binaries=[],
    datas=[(str(root / 'frontend/dist'), 'frontend/dist')]
        + collect_data_files('webview') + collect_data_files('pypdfium2_raw'),
    hiddenimports=collect_submodules('uvicorn') + ['webview.platforms.cocoa', 'backend.app'],
    excludes=['pytest', 'tkinter', 'PyQt5', 'PyQt6', 'PySide2', 'PySide6'],
)
pyz = PYZ(analysis.pure)
exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name='Slide Explain',
    console=False, target_arch='arm64', codesign_identity=None)
collection = COLLECT(exe, analysis.binaries, analysis.datas, name='Slide Explain')
app = BUNDLE(collection, name='Slide Explain.app', icon=str(root / 'desktop/icon.icns'),
    bundle_identifier='com.slidenotes.desktop', version='0.1.0', info_plist={
        'NSHighResolutionCapable': True,
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        'NSHumanReadableCopyright': 'Slide Explain',
    })
