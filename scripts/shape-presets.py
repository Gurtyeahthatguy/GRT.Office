"""Development only: asks the installed LibreOffice for the geometry of every custom shape, its own and OOXML's presets; scripts/shape-presets.mjs turns the result into core/js/draw/presets.js."""
import json, os, re, subprocess, sys, tempfile, time, zipfile, uno
from com.sun.star.beans import PropertyValue
from com.sun.star.awt import Size, Point
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
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
url = lambda p: uno.systemPathToFileUrl(os.path.abspath(p))
own = sys.argv[1].split(',')
ooxml = re.findall(r'^/\* (\w+) \*/$', open('/usr/lib/libreoffice/share/filter/oox-drawingml-cs-presets').read(), re.M)
try:
    doc = desktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, (prop("Hidden", True),))
    page = doc.DrawPages.getByIndex(0)
    for i, t in enumerate(own):
        s = doc.createInstance("com.sun.star.drawing.CustomShape"); page.add(s)
        s.Position = Point(500 + (i % 12) * 1700, 500 + (i // 12) * 1700); s.Size = Size(1500, 1000); s.Name = t
        s.CustomShapeGeometry = tuple([g for g in s.CustomShapeGeometry if g.Name != 'Type'] + [prop('Type', t)])
    doc.storeToURL(url(f'{here}/own.odg'), (prop("FilterName", "draw8"),)); doc.close(True)
    doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, (prop("Hidden", True),))
    page = doc.DrawPages.getByIndex(0)
    for i, t in enumerate(own):
        s = doc.createInstance("com.sun.star.drawing.CustomShape"); page.add(s)
        s.Position = Point(200 + (i % 12) * 2000, 200 + (i // 12) * 1700); s.Size = Size(1500, 1000); s.Name = 'O' + t
        s.CustomShapeGeometry = tuple([g for g in s.CustomShapeGeometry if g.Name != 'Type'] + [prop('Type', t)])
    doc.storeToURL(url(f'{here}/own.pptx'), (prop("FilterName", "Impress Office Open XML"),)); doc.close(True)
    # OOXML presets: rectangles saved as .pptx, renamed to every preset, read back and kept as .odp.
    doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, (prop("Hidden", True),))
    page = doc.DrawPages.getByIndex(0)
    for i, t in enumerate(ooxml):
        s = doc.createInstance("com.sun.star.drawing.CustomShape"); page.add(s)
        s.Position = Point(200 + (i % 16) * 1600, 200 + (i // 16) * 1500); s.Size = Size(1400, 1000); s.Name = 'P' + t
        s.CustomShapeGeometry = tuple([g for g in s.CustomShapeGeometry if g.Name != 'Type'] + [prop('Type', 'rectangle')])
    doc.storeToURL(url(f'{here}/rects.pptx'), (prop("FilterName", "Impress Office Open XML"),)); doc.close(True)
    with zipfile.ZipFile(f'{here}/rects.pptx') as z:
        parts = {n: z.read(n) for n in z.namelist()}
    xml = parts['ppt/slides/slide1.xml'].decode()
    def rename(m):
        name = m.group(1)[1:]
        return m.group(0)
    shapes = re.split(r'(?=<p:sp>)', xml)
    out = []
    for piece in shapes:
        m = re.search(r'name="P(\w+)"', piece)
        if m and '<a:prstGeom prst="' in piece:
            piece = re.sub(r'<a:prstGeom prst="\w+">', f'<a:prstGeom prst="{m.group(1)}">', piece, count=1)
        out.append(piece)
    parts['ppt/slides/slide1.xml'] = ''.join(out).encode()
    with zipfile.ZipFile(f'{here}/presets.pptx', 'w', zipfile.ZIP_DEFLATED) as z:
        for n, b in parts.items(): z.writestr(n, b)
    doc = desktop.loadComponentFromURL(url(f'{here}/presets.pptx'), "_blank", 0, (prop("Hidden", True),))
    doc.storeToURL(url(f'{here}/presets.odp'), (prop("FilterName", "impress8"),)); doc.close(True)
finally:
    try: desktop.terminate()
    except Exception: pass
    office.wait(timeout=60)
print(len(own), len(ooxml))
