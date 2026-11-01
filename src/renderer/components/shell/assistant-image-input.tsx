import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { FileText, ImagePlus, X } from 'lucide-react';
import { CommandDocumentSchema, CommandImageSchema, MAX_COMMAND_DOCUMENTS, MAX_COMMAND_DOCUMENT_TOTAL_CHARACTERS, MAX_COMMAND_IMAGES, MAX_IMAGE_BYTES, type CommandDocument, type SelectedImage } from '../../../shared/contracts';
import { imageDataUrlByteLength } from '../../../shared/images';
import type { PlannerUI } from '../../hooks/usePlanner';
import { readBrowserImage } from '../../mobile/browser-image';
import './assistant-images.css';

/** Attachment content stays in memory; cancelling a read invalidates its eventual result. */
export function useAssistantImage(ui: PlannerUI, blocked: () => boolean) {
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [documents, setDocuments] = useState<CommandDocument[]>([]);
  const [imageReading, setImageReading] = useState(false);
  const [imageError, setImageError] = useState('');
  const currentImages = useRef<SelectedImage[]>([]), currentDocuments = useRef<CommandDocument[]>([]);
  const reading = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  async function read(load: () => Promise<{ images?: SelectedImage[]; documents?: CommandDocument[] } | null>) {
    if (blocked() || reading.current) return;
    const id = ++generation.current;
    reading.current = true; setImageReading(true); setImageError('');
    try {
      const selected = await load();
      if (id !== generation.current || blocked() || !selected) return;
      const nextImages = [...currentImages.current, ...(selected.images ?? [])];
      if (nextImages.length > MAX_COMMAND_IMAGES) throw Error('每条消息最多 4 张图片，请移除部分图片后再选择。');
      for (const image of nextImages) if (!CommandImageSchema.safeParse(image).success) throw Error('请选择不超过 10 MB 的 PNG 或 JPEG 图片。');
      if (nextImages.reduce((total, image) => total + imageDataUrlByteLength(image.imageDataUrl), 0) > MAX_IMAGE_BYTES) throw Error('图片合计不能超过 10 MB，请缩小图片或减少数量。');
      const nextDocuments = [...currentDocuments.current, ...(selected.documents ?? []).map(document => CommandDocumentSchema.parse(document))];
      if (nextDocuments.length > MAX_COMMAND_DOCUMENTS) throw Error('每条消息最多读取 3 份文件，请移除部分文件后再选择。');
      if (nextDocuments.reduce((total, document) => total + document.text.length, 0) > MAX_COMMAND_DOCUMENT_TOTAL_CHARACTERS) throw Error('文件文字合计不能超过 100000 字，请拆分后发送。');
      currentImages.current = nextImages; setImages(nextImages);
      currentDocuments.current = nextDocuments; setDocuments(nextDocuments);
    } catch (error) {
      if (id === generation.current) setImageError(error instanceof Error ? error.message : '附件读取失败，请重新选择。');
    } finally {
      if (id === generation.current) { reading.current = false; setImageReading(false); }
    }
  }
  function cancelRead() {
    generation.current++; reading.current = false; setImageReading(false); setImageError('');
  }
  function removeImage(index: number) {
    cancelRead(); currentImages.current = currentImages.current.filter((_, item) => item !== index); setImages(currentImages.current);
  }
  function removeDocument(index: number) {
    cancelRead(); currentDocuments.current = currentDocuments.current.filter((_, item) => item !== index); setDocuments(currentDocuments.current);
  }
  function clearAttachments() {
    cancelRead(); currentImages.current = []; currentDocuments.current = []; setImages([]); setDocuments([]);
  }
  const readImageFiles = (files: File[]) => void read(async () => {
    if (files.length + currentImages.current.length > MAX_COMMAND_IMAGES) throw Error('每条消息最多 4 张图片，请移除部分图片后再选择。');
    if (files.reduce((total, file) => total + file.size, currentImages.current.reduce((total, image) => total + imageDataUrlByteLength(image.imageDataUrl), 0)) > MAX_IMAGE_BYTES) throw Error('图片合计不能超过 10 MB，请缩小图片或减少数量。');
    return { images: await Promise.all(files.map(readBrowserImage)) };
  });
  function selectDocuments() {
    const choose = ui.host?.selectCommandDocuments;
    if (!choose) return;
    void read(async () => {
      const result = await choose();
      if (!result.ok) throw Error(result.error.message);
      return result.data ? { documents: result.data } : null;
    });
  }
  function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    const images = files.length ? files : Array.from(event.clipboardData.items).flatMap(item => {
      const file = item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    if (!images.length) return;
    event.preventDefault(); readImageFiles(images);
  }
  return { images, documents, imageReading, imageError, currentImages, currentDocuments, reading, readImageFiles, pasteImage, selectDocuments, removeImage, removeDocument, cancelRead, clearAttachments };
}

export function AssistantImageButton({ readImageFiles, disabled, mobile = false, tabIndex }: {
  readImageFiles: (files: File[]) => void; disabled: boolean; mobile?: boolean; tabIndex?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" accept="image/png,image/jpeg" multiple hidden disabled={disabled} tabIndex={-1} aria-label="选择助手图片文件"
      onChange={event => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length) readImageFiles(files);
      }} />
    <button type="button" className={mobile ? 'm-icon assistant-image-button' : 'ui-btn ghost icon'}
      disabled={disabled} aria-label="添加图片" title="添加图片（最多 4 张 PNG/JPEG，合计 10 MB，可多选或粘贴）"
      tabIndex={tabIndex} onClick={() => input.current?.click()}><ImagePlus aria-hidden="true" /></button>
  </>;
}

export function AssistantAttachmentDraft({ images, documents, reading, error, removeImage, removeDocument, cancelRead, disabled, tabIndex }: {
  images: SelectedImage[]; documents: CommandDocument[]; reading: boolean; error: string;
  removeImage: (index: number) => void; removeDocument: (index: number) => void; cancelRead: () => void; disabled: boolean; tabIndex?: number;
}) {
  if (!images.length && !documents.length && !reading && !error) return null;
  return <div className="assistant-attachments-draft">
    <div className="assistant-attachment-list">
      {images.map((image, index) => <div className="assistant-image-draft" key={`image:${index}`}>
        <img src={image.imageDataUrl} alt={`待发送图片：${image.label}`} />
        <div className="assistant-image-info"><span>{image.label || '待发送图片'}</span></div>
        <button type="button" className="ui-btn ghost icon" disabled={disabled} aria-label={`移除图片：${image.label}`} tabIndex={tabIndex} onClick={() => removeImage(index)}><X aria-hidden="true" /></button>
      </div>)}
      {documents.map((document, index) => <div className="assistant-image-draft assistant-document-draft" key={`document:${index}`}>
        <FileText aria-hidden="true" />
        <div className="assistant-image-info"><span>{document.label}</span><small>已读取 {document.text.length.toLocaleString()} 字，发送后交给 AI 分析</small>
          {document.warnings?.map((warning, item) => <small className="assistant-image-error" key={item}>{warning}</small>)}</div>
        <button type="button" className="ui-btn ghost icon" disabled={disabled} aria-label={`移除文件：${document.label}`} tabIndex={tabIndex} onClick={() => removeDocument(index)}><X aria-hidden="true" /></button>
      </div>)}
    </div>
    {images.length > 0 && <small className="ui-hint">{images.length} / 4 张图片 · 再次选择会追加</small>}
    {reading && <div className="assistant-attachment-loading"><span role="status">正在读取附件…</span><button type="button" className="ui-btn sm" disabled={disabled} onClick={cancelRead} tabIndex={tabIndex}>取消读取</button></div>}
    {error && <span className="assistant-image-error" role="alert">{error}</span>}
  </div>;
}

export function AssistantMessageAttachments({ image, images, documents, imageUnavailable, documentsUnavailable }: {
  image?: SelectedImage; images?: SelectedImage[]; documents?: CommandDocument[]; imageUnavailable?: boolean; documentsUnavailable?: boolean;
}) {
  const pictures = images ?? (image ? [image] : []);
  return <>
    {pictures.length ? <div className="assistant-message-images">{pictures.map((picture, index) => <img key={index} className="assistant-message-image" src={picture.imageDataUrl} alt={`已选图片：${picture.label}`} />)}</div>
      : imageUnavailable && <small className="assistant-image-unavailable">图片未保存在本机，重新打开后如需继续看图，请重新选择图片。</small>}
    {documents?.map((document, index) => <small className="assistant-message-document" key={index}><FileText aria-hidden="true" />{document.label}</small>)}
    {documentsUnavailable && <small className="assistant-image-unavailable">文件内容未保存在本机，如需继续分析，请在电脑重新选择文件。</small>}
  </>;
}
