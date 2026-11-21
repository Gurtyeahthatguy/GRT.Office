"""Development only: inserts shapes through LibreOffice's own menu commands, for the ones whose command names no type of their own; writes dispatched.odg for scripts/shape-presets.mjs."""
import os, subprocess, sys, tempfile, time, uno
from com.sun.star.beans import PropertyValue
here = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.getcwd())
profile = os.path.join(tempfile.gettempdir(), f"grt-shapes-{os.getpid()}")
pipe = f"grtshapes{os.getpid()}"
office = subprocess.Popen(["soffice", "--headless", "--invisible", "--norestore", "--nologo", f"-env:UserInstallation=file://{profile}", f"--accept=pipe,name={pipe};urp;"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def prop(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p
local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
for _ in range(120):
    try:
        ctx = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext"); break
    except Exception: time.sleep(0.5)
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
helper = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
try:
    doc = desktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, (prop("Hidden", True),))
    frame = doc.CurrentController.Frame
    for cmd in sys.argv[1].split(','):
        helper.executeDispatch(frame, f".uno:{cmd}", "", 0, (prop("KeyModifier", 8192),))
        time.sleep(0.3)
    page = doc.DrawPages.getByIndex(0)
    for i in range(page.Count):
        s = page.getByIndex(i)
        t = [g.Value for g in s.CustomShapeGeometry if g.Name == 'Type'] if hasattr(s, 'CustomShapeGeometry') else ['-']
        print(i, s.ShapeType, t, s.Size.Width, s.Size.Height)
    open(f'{here}/dispatched.txt', 'w').write(','.join(c.split('.', 1)[1] for c in sys.argv[1].split(',')))
    doc.storeToURL(uno.systemPathToFileUrl(f'{here}/dispatched.odg'), (prop("FilterName", "draw8"),)); doc.close(True)
finally:
    try: desktop.terminate()
    except Exception: pass
    office.wait(timeout=60)
