'use client';

import DOMPurify from 'dompurify';
import { useMemo } from 'react';

const ALLOWED_TAGS = [
  'h2',
  'h3',
  'p',
  'ul',
  'ol',
  'li',
  'a',
  'strong',
  'em',
  'br',
] as const;

const ALLOWED_ATTR = ['href', 'target', 'rel'] as const;

/** True when the description already contains HTML anchor tags. */
export function hasHtmlAnchorTags(text: string): boolean {
  return /<a\b/i.test(text);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

const PLAIN_URL_RE =
  /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)'\]"]*)/gi;

/**
 * Wrap http(s) and www. URLs in anchor tags. Call only when {@link hasHtmlAnchorTags} is false.
 */
export function linkifyPlainTextUrls(text: string): string {
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(PLAIN_URL_RE)) {
    const index = match.index ?? 0;
    result += escapeHtml(text.slice(lastIndex, index));

    let url = match[1]!;
    let trailing = '';
    const trailMatch = url.match(/([),.!?:;]+)$/);
    if (trailMatch) {
      trailing = trailMatch[1]!;
      url = url.slice(0, -trailing.length);
    }

    const href = url.startsWith('www.') ? `https://${url}` : url;
    result += `<a href="${escapeHtmlAttr(href)}">${escapeHtml(url)}</a>`;
    result += escapeHtml(trailing);
    lastIndex = index + match[0].length;
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}

/** Auto-link plain-text URLs; leave HTML descriptions (with existing anchors) unchanged. */
export function prepareDescriptionHtml(description: string): string {
  if (!description.trim()) return '';
  if (hasHtmlAnchorTags(description)) return description;
  return linkifyPlainTextUrls(description);
}

let linkHookInstalled = false;

function ensureLinkHook() {
  if (linkHookInstalled || typeof window === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  linkHookInstalled = true;
}

export function sanitizeDescriptionHtml(html: string): string {
  ensureLinkHook();
  const prepared = prepareDescriptionHtml(html);
  return DOMPurify.sanitize(prepared, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
  });
}

interface HtmlDescriptionProps {
  html: string;
  className?: string;
}

/** Renders POI description HTML (or plain text) after DOMPurify sanitization. */
export function HtmlDescription({ html, className }: HtmlDescriptionProps) {
  const sanitized = useMemo(
    () => sanitizeDescriptionHtml(html),
    [html],
  );

  if (!sanitized) return null;

  return (
    <div
      className={className ?? 'poi-description text-sm text-gray-600 leading-relaxed'}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
