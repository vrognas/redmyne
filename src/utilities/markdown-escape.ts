/**
 * Escape Markdown syntax in server-controlled text before interpolating it
 * into a vscode.MarkdownString. Blocks link/command-URI injection (e.g. a
 * Redmine issue subject containing "[x](command:...)"), images, raw HTML,
 * and emphasis. Block-level chars (#, -, +, ~) stay unescaped — they are
 * cosmetic only and escaping them garbles dates and plain prose.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>!]/g, "\\$&");
}
