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
  return DOMPurify.sanitize(html, {
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
  const sanitized = useMemo(() => sanitizeDescriptionHtml(html), [html]);

  if (!sanitized) return null;

  return (
    <div
      className={className ?? 'poi-description text-sm text-gray-600 leading-relaxed'}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
