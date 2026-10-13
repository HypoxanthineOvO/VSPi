import type { ContentPart } from '../message';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

const MEDIA_PATH_TAG_RE = /<(image|video|audio|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?/g;

export interface MediaPathTag {
  readonly kind: MediaKind;
  readonly path: string;
  readonly index: number;
  readonly text: string;
}

export function escapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function unescapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function buildMediaPathTag(kind: MediaKind, path: string): string {
  return `<${kind} path="${escapeMediaAttribute(path)}"></${kind}>`;
}

export function matchMediaPathTags(text: string): MediaPathTag[] {
  const tags: MediaPathTag[] = [];
  for (const match of text.matchAll(MEDIA_PATH_TAG_RE)) {
    tags.push({
      kind: match[1] as MediaKind,
      path: unescapeMediaAttribute(match[2]!),
      index: match.index,
      text: match[0],
    });
  }
  return tags;
}

export function matchSingleMediaPathTag(text: string): MediaPathTag | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const tags = matchMediaPathTags(trimmed);
  if (tags.length !== 1) return undefined;
  const tag = tags[0]!;
  return tag.index === 0 && tag.text.length === trimmed.length ? tag : undefined;
}

const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

const CAPTION_PATTERN = /<system>(Image compressed to fit model limits:[\s\S]*?)<\/system>/g;

export interface ImageCompressionCaptionExtraction {
  readonly captions: readonly string[];
  readonly text: string;
}

export function extractImageCompressionCaptions(text: string): ImageCompressionCaptionExtraction {
  if (!text.includes(CAPTION_OPENING)) return { captions: [], text };
  const captions: string[] = [];
  const remainder = text.replace(CAPTION_PATTERN, (_match, body: string) => {
    captions.push(body);
    return '';
  });
  return { captions, text: remainder };
}

export function promptDisplayTextFromContentParts(parts: readonly ContentPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    const text = promptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return texts.join('\n');
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text': {
      if (matchSingleMediaPathTag(part.text) !== undefined) return undefined;
      const { text } = extractImageCompressionCaptions(part.text);
      return text.trim().length === 0 ? undefined : text;
    }
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
}
