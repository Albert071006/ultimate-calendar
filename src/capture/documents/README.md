# QQ 附件正文提取

主进程调用 `createDocumentExtractor()`（`runtime.ts`），使用 `extract({ bytes, name }, signal?)`，退出时调用 `dispose()`。结果包括逐页、段落、表格、单元格定位，正文、可用于视觉识别的 PNG/JPEG，以及可见的错误或缺失说明。提取器本身不调用 AI、不判断截止日期、不读取 QQ。

- 文本、扫描及混合 PDF：应用打包的 PDF.js 6.4.299，在独立 Electron sandbox 页面里解析；图片页输出 PNG。网页请求只允许同一打包目录的文件。PDF JavaScript/XFA 不执行。
- DOCX/PPTX：受限 ZIP/XML，按文档关系读取正文、表格、页眉页脚、备注和图片。图片格式或图表不完整时保留明确核对说明；DOCX 不伪造页码。
- XLSX：按关系顺序读取全部工作表、单元格地址与已有公式缓存，日期按单元格格式呈现；不计算公式。
- XLS：SheetJS 官方 0.20.3，读取 BIFF 原有缓存，不经过 Office 转换；旧工作簿中的绘图/图表提示手动核对。依赖来自官方发布源 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`。
- DOC/PPT：使用独立安装的 LibreOffice（已验证 26.8.1），需要 `soffice.exe` 与其自带 Python。按顺序检测 `PLANNER_LIBREOFFICE_DIR` 指定的安装根目录或 `program` 目录、系统 `Program Files` / `Program Files (x86)` 中的 LibreOffice、`PATH`，最后兼容 `C:\Software\LibreOffice\program` 和 `C:\Software\LibreOffice\runtime\program`。环境变量请使用绝对路径，并在启动日历前设置。每次使用独立临时 profile 和随机本机 UNO pipe，隐藏只读加载，明确设置 `MacroExecutionMode=NEVER_EXECUTE`、`UpdateDocMode=NO_UPDATE`，拒绝所有交互请求。加密文件明确返回 `encrypted`。不借用 WPS、不依赖 Codex 运行时。
- TXT/CSV/MD：UTF-8、带 BOM 的 UTF-16；GB18030 回退会提示核对。CSV 中公式仅作为文字。
- 图片：尺寸元数据、解码及大小校验；GIF/WebP 经 sandbox canvas 转 PNG，GIF 仅识别首帧并提示。

输入 25 MB，ZIP 实际解压 200 MB，单 XML 32 MB，正文 500 万字符，PDF 500 页，单图 10 MB / 1600 万像素，全部图片 80 MB。单次解析最多 60 秒；Office/文字解析在受内存限制的 Worker 中执行，避免阻塞主界面。压缩包不展开，超限、加密、损坏、缺失内容不会标成完整成功。

验证：`npx vitest run src/capture/documents/documents.test.ts`；构建后运行 `node scripts/document-smoke.mjs`。未部署 LibreOffice 的环境可使用 `--no-legacy`。打包资源验证可附加 `--runtime-directory=release/win-unpacked/resources/app.asar/dist-electron`。报告写入 `test-results/qq-document-runtime-report.json`，运行临时文件保存在已忽略的 `test-results/`，脚本会自动创建该目录。

`fixtures/` 中的 DOC/XLS/PPT、加密 DOC/PDF 和 WebP 都是合成测试文件，总计约 510 KB，无真实群内容。`create-legacy-fixtures.py` 可用 LibreOffice 自带 Python 重新生成 Office/PDF fixture；测试密码仅为 `synthetic-fixture-only`。
