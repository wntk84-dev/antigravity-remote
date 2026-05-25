const config = require('./config');

/**
 * Convert HTML from Antigravity response to Telegram MarkdownV2.
 * Handles code blocks, bold, italic, links, and lists.
 */
function htmlToTelegram(html, plainText) {
  if (!html && !plainText) return '';

  let text = plainText || '';

  // If we have HTML, do a better extraction
  if (html) {
    text = html
      // Code blocks: <pre><code>...</code></pre>
      .replace(/<pre[^>]*><code[^>]*class="[^"]*language-(\w+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
        (_, lang, code) => `\n\`\`\`${lang}\n${decodeEntities(code).trim()}\n\`\`\`\n`)
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
        (_, code) => `\n\`\`\`\n${decodeEntities(code).trim()}\n\`\`\`\n`)
      // Inline code
      .replace(/<code[^>]*>(.*?)<\/code>/gi, (_, code) => `\`${decodeEntities(code)}\``)
      // Bold
      .replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, (_, __, text) => `*${text}*`)
      // Italic
      .replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, (_, __, text) => `_${text}_`)
      // Links
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, url, text) => `[${text}](${url})`)
      // Line breaks
      .replace(/<br\s*\/?>/gi, '\n')
      // List items
      .replace(/<li[^>]*>(.*?)<\/li>/gi, (_, content) => `• ${content.trim()}\n`)
      // Paragraphs
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<p[^>]*>/gi, '')
      // Headings
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, (_, text) => `\n*${text.trim()}*\n`)
      // Strip remaining HTML tags
      .replace(/<[^>]+>/g, '')
      // Decode HTML entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Clean up whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return text;
}

/** Decode HTML entities in code blocks */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Split a long message into chunks that fit Telegram's limit.
 * Tries to split at newlines to keep code blocks intact.
 */
function splitMessage(text, maxLen = config.telegramMaxLength) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // No good newline found, split at space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good split point, hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * Only escapes outside of code blocks.
 */
function escapeMarkdownV2(text) {
  // Characters that need escaping in MarkdownV2
  const special = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

  // Split by code blocks to avoid escaping inside them
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/);

  return parts.map((part, i) => {
    // Odd indices are code blocks, don't escape
    if (i % 2 === 1) return part;
    // Escape special chars
    let escaped = part;
    for (const char of special) {
      escaped = escaped.replaceAll(char, `\\${char}`);
    }
    return escaped;
  }).join('');
}

module.exports = { htmlToTelegram, splitMessage, escapeMarkdownV2 };
