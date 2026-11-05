"""LibreOffice Base as the oracle for .odb files, through UNO; for tests on a development machine, nothing here ships.

make OUT.odb ENGINE SPEC.json: a new embedded database (hsqldb or firebird) built by running the spec's statements.
dump IN.odb: what LibreOffice reads in a .odb, as JSON: tables with columns and rows, queries, forms and reports.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

import uno
from com.sun.star.beans import PropertyValue

profile = os.path.join(tempfile.gettempdir(), f"grt-oracle-base-{os.getpid()}")
pipe = f"grtbase{os.getpid()}"
office = subprocess.Popen(
    ["soffice", "--headless", "--invisible", "--norestore", "--nologo", f"-env:UserInstallation=file://{profile}", f"--accept=pipe,name={pipe};urp;"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def prop(name, value):
    out = PropertyValue()
    out.Name = name
    out.Value = value
    return out


def connect():
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for _ in range(120):
        try:
            return resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
        except Exception:
            time.sleep(0.5)
    raise SystemExit("LibreOffice did not start")


def main():
    ctx = connect()
    smgr = ctx.ServiceManager
    dbctx = smgr.createInstanceWithContext("com.sun.star.sdb.DatabaseContext", ctx)
    try:
        if sys.argv[1] == "make":
            out, engine, spec = sys.argv[2], sys.argv[3], json.load(open(sys.argv[4]))
            if os.path.exists(out):
                os.remove(out)
            source = dbctx.createInstance()
            source.URL = "sdbc:embedded:" + engine
            document = source.DatabaseDocument
            document.storeAsURL(uno.systemPathToFileUrl(out), ())
            connection = source.getConnection("", "")
            statement = connection.createStatement()
            for sql in spec.get("sql", []):
                statement.execute(sql)
            for name, command in spec.get("queries", {}).items():
                query = smgr.createInstanceWithContext("com.sun.star.sdb.QueryDefinition", ctx)
                query.Command = command
                source.QueryDefinitions.insertByName(name, query)
            connection.close()
            document.store()
            document.close(True)
            print(json.dumps({"made": out}))
        else:
            path = sys.argv[2]
            source = dbctx.getByName(uno.systemPathToFileUrl(path))
            connection = source.getConnection("", "")
            tables = {}
            for name in connection.getTables().getElementNames():
                result = connection.createStatement().executeQuery(f'SELECT * FROM "{name}"')
                meta = result.getMetaData()
                columns = [(meta.getColumnName(i), meta.getColumnTypeName(i)) for i in range(1, meta.getColumnCount() + 1)]
                rows = []
                while result.next():
                    row = []
                    for i in range(1, len(columns) + 1):
                        value = result.getString(i)
                        row.append(None if result.wasNull() else value)
                    rows.append(row)
                tables[name] = {"columns": columns, "rows": rows}
            document = source.DatabaseDocument
            controls = {}
            for name in document.FormDocuments.getElementNames():
                try:
                    form = document.FormDocuments.loadComponentFromURL(name, "", 0, (prop("ActiveConnection", connection), prop("OpenMode", "open")))
                    main = form.DrawPage.Forms.getByIndex(0)
                    fields = [getattr(main.getByIndex(i), "DataField", None) for i in range(main.getCount())]
                    controls[name] = {"command": main.Command, "fields": [f for f in fields if f]}
                except Exception as error:
                    controls[name] = {"error": str(error)}
            outputs = {}
            for name in document.ReportDocuments.getElementNames():
                try:
                    output = document.ReportDocuments.loadComponentFromURL(name, "", 0, (prop("ActiveConnection", connection), prop("OpenMode", "open")))
                    text = os.path.join(profile + "-out.txt")
                    output.storeToURL(uno.systemPathToFileUrl(text), (prop("FilterName", "Text (encoded)"), prop("FilterOptions", "UTF8")))
                    outputs[name] = open(text, encoding="utf-8-sig").read()
                    os.remove(text)
                except Exception as error:
                    outputs[name] = {"error": str(error)}
            print(json.dumps({
                "reportOutputs": outputs,
                "formControls": controls,
                "tables": tables,
                "queries": {name: source.QueryDefinitions.getByName(name).Command for name in source.QueryDefinitions.getElementNames()},
                "forms": list(document.FormDocuments.getElementNames()),
                "reports": list(document.ReportDocuments.getElementNames()),
            }, default=str))
            try:
                connection.close()
            except Exception:
                pass
    finally:
        office.terminate()
        subprocess.run(["rm", "-rf", profile])


main()
