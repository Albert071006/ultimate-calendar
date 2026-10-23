"""Generate synthetic binary Office documents with the independently installed LibreOffice runtime."""
import os, sys, time, tempfile, subprocess
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.document.MacroExecMode import NEVER_EXECUTE
from com.sun.star.document.UpdateDocMode import NO_UPDATE

def prop(name, value):
    item = PropertyValue(); item.Name = name; item.Value = value; return item

folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
os.makedirs(folder, exist_ok=True)
profile = tempfile.mkdtemp(prefix='ultimate-calendar-fixtures-')
pipe = 'calendarfixtures' + str(os.getpid())
process = subprocess.Popen([os.path.join(os.path.dirname(sys.executable), 'soffice.exe'), '-env:UserInstallation=' + uno.systemPathToFileUrl(profile), '--headless', '--norestore', '--nodefault', '--nofirststartwizard', '--accept=pipe,name=' + pipe + ';urp;StarOffice.ComponentContext'], creationflags=subprocess.CREATE_NO_WINDOW)
local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
context = None
desktop = None
try:
    for attempt in range(100):
        try: context = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext'); break
        except Exception: time.sleep(0.2)
    if context is None: raise RuntimeError('No fixture component')
    desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
    for extension, factory, filter_name in [('doc', 'swriter', 'MS Word 97'), ('xls', 'scalc', 'MS Excel 97'), ('ppt', 'simpress', 'MS PowerPoint 97')]:
        doc = desktop.loadComponentFromURL('private:factory/' + factory, '_blank', 0, (prop('Hidden', True), prop('MacroExecutionMode', NEVER_EXECUTE), prop('UpdateDocMode', NO_UPDATE)))
        if extension == 'doc': doc.Text.String = 'Synthetic assignment: submit report Friday. Reward: 2 credits.'
        elif extension == 'xls':
            sheet = doc.Sheets.getByIndex(0)
            sheet.getCellRangeByName('A1').String = 'Synthetic report Friday'
            sheet.getCellRangeByName('B1').Formula = '=1+1'
            doc.Sheets.insertNewByName('Second sheet', 1)
            doc.Sheets.getByIndex(1).getCellRangeByName('A1').String = 'Reward 2 credits'
        else:
            shape = doc.createInstance('com.sun.star.drawing.TextShape')
            page = doc.DrawPages.getByIndex(0); page.add(shape)
            size = uno.createUnoStruct('com.sun.star.awt.Size'); size.Width = 20000; size.Height = 5000; shape.setSize(size)
            shape.String = 'Synthetic competition: register Friday. Reward: 2 credits.'
        doc.storeToURL(uno.systemPathToFileUrl(os.path.join(folder, 'notice.' + extension)), (prop('FilterName', filter_name), prop('Overwrite', True)))
        if extension == 'doc': doc.storeToURL(uno.systemPathToFileUrl(os.path.join(folder, 'encrypted.doc')), (prop('FilterName', filter_name), prop('Overwrite', True), prop('Password', 'synthetic-fixture-only')))
        if extension == 'doc': doc.storeToURL(uno.systemPathToFileUrl(os.path.join(folder, 'encrypted.pdf')), (prop('FilterName', 'writer_pdf_Export'), prop('Overwrite', True), prop('FilterData', uno.Any('[]com.sun.star.beans.PropertyValue', (prop('EncryptFile', True), prop('DocumentOpenPassword', 'synthetic-fixture-only'))))))
        doc.close(True)
    print('Generated three synthetic binary Office fixtures')
finally:
    if desktop: desktop.terminate()
    try: process.wait(timeout=10)
    except Exception: process.terminate()
