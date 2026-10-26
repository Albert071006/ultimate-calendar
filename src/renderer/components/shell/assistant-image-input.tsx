import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { CommandImageSchema, type SelectedImage } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import { readBrowserImage } from '../../mobile/browser-image';
import './assistant-images.css';

/** Keep image bytes in memory only, with a generation guard for cancelled/replaced reads. */
export function useAssistantImage(ui: PlannerUI, blocked: () => boolean) {
  const [image, setImage] = useState<SelectedImage | null>(null);
  const [imageReading, setImageReading] = useState(false);
  const [imageError, setImageError] = useState('');
  const currentImage = useRef<SelectedImage | null>(null);
  const reading = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  async function read(load: () => Promise<SelectedImage | null>) {
    if (blocked()) return;
    const id = ++generation.current;
    reading.current = true;
    setImageReading(true);
    setImageError('');
    try {
      const selected = await load();
      if (id !== generation.current || blocked()) return;
      if (selected) {
        const parsed = CommandImageSchema.safeParse(selected);
        if (!parsed.success) throw new Error('请选择不超过 10 MB 的 PNG 或 JPEG 图片。');
        currentImage.current = selected;
        setImage(selected);
      }
    } catch (error) {
      if (id === generation.current) setImageError(error instanceof Error ? error.message : '图片读取失败，请重新选择。');
    } finally {
      if (id === generation.current) { reading.current = false; setImageReading(false); }
    }
  }
  function removeImage() {
    generation.current++;
    currentImage.current = null;
    reading.current = false;
    setImage(null);
    setImageReading(false);
    setImageError('');
  }
  function selectImage(openFilePicker: () => void) {
    if (blocked() || reading.current) return;
    if (!ui.host?.selectImage) { openFilePicker(); return; }
    void read(async () => {
      const result = await ui.host!.selectImage();
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    });
  }
  const readImageFile = (file: File) => void read(() => readBrowserImage(file));
  function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    const imageFile = files.find(file => file.type.startsWith('image/'))
      ?? Array.from(event.clipboardData.items).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!imageFile) return;
    event.preventDefault();
    readImageFile(imageFile);
  }
  return { image, imageReading, imageError, currentImage, reading, selectImage, readImageFile, pasteImage, removeImage };
}

export function AssistantImageButton({ selectImage, readImageFile, disabled, mobile = false, tabIndex }: {
  selectImage: (openFilePicker: () => void) => void; readImageFile: (file: File) => void;
  disabled: boolean; mobile?: boolean; tabIndex?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" accept="image/png,image/jpeg" hidden tabIndex={-1} aria-label="选择助手图片文件"
      onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) readImageFile(file);
      }} />
    <button type="button" className={mobile ? 'm-icon assistant-image-button' : 'ui-btn ghost icon'}
      disabled={disabled} aria-label="添加图片" title="添加图片（每条一张 PNG/JPEG，最大 10 MB，也可粘贴）"
      tabIndex={tabIndex} onClick={() => selectImage(() => input.current?.click())}>
      <ImagePlus aria-hidden="true" />
    </button>
  </>;
}

export function AssistantImageDraft({ image, reading, error, remove, disabled, tabIndex }: {
  image: SelectedImage | null; reading: boolean; error: string; remove: () => void; disabled: boolean; tabIndex?: number;
}) {
  if (!image && !reading && !error) return null;
  return <div className="assistant-image-draft">
    {image && <img src={image.imageDataUrl} alt={`待发送图片：${image.label}`} />}
    <div className="assistant-image-info">
      {reading ? <span role="status">正在读取图片…</span> : image && <><span>{image.label || '待发送图片'}</span><small>每条一张 · 再次选图会替换</small></>}
      {error && <span className="assistant-image-error" role="alert">{error}</span>}
    </div>
    {(image || reading) && <button type="button" className="ui-btn ghost icon" disabled={disabled} aria-label="移除图片" tabIndex={tabIndex} onClick={remove}><X aria-hidden="true" /></button>}
  </div>;
}

export function AssistantMessageImage({ image, unavailable }: { image?: SelectedImage; unavailable?: boolean }) {
  return image ? <img className="assistant-message-image" src={image.imageDataUrl} alt={`已选图片：${image.label}`} />
    : unavailable ? <small className="assistant-image-unavailable">图片未保存在本机，重新打开后如需继续看图，请重新选择图片。</small> : null;
}
